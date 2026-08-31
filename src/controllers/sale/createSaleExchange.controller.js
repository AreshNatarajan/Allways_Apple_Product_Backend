// controllers/sale/createSaleExchange.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import SaleExchange from "../../models/SaleExchange.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Product from "../../models/Product.modal.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const buildValidationError = (message) => {
    const err = new Error(message);
    err.isValidation = true;
    return err;
};

// ============================================================
// Sale Exchange (phase 1: serialized only, one old item for one new
// item) - a customer swaps an already-sold unit for a different
// available one. Applies immediately (no pending-approval gate) - old
// unit goes back to AVAILABLE, new unit becomes SOLD, both in the same
// transaction, exactly like Return's own stock reversal/reapplication.
// The safety net is the SAME EOD review as everything else on this sale
// (see reviewSale.controller.js) - this resets sale.processStatus back
// to PENDING_REVIEW for a non-SUPER_ADMIN-created exchange, and that
// one review action cascades to any PENDING_REVIEW SaleExchange too -
// there is no separate per-exchange review.
//
// The original Sale document is never modified beyond that EOD-review
// reset - no items/totals write, ever. sale.items still lists only the
// original (now-returned-to-stock) unit; the new unit is tracked
// exclusively on this SaleExchange record plus a soft ProductSerial.saleId
// link (so a future Return against the exchanged-in unit works normally).
//
// The new item's own pricing/GST/discount/complimentary calculation
// mirrors createSale.controller.js's serialized branch exactly (same
// subtotal -> discount -> taxable -> margin-scheme GST -> finalAmount
// formula), so a new-unit line here is priced identically to how the
// same unit would have been priced on a fresh Sale. sellingPrice/
// discount/complimentary are staff-adjustable client input, exactly as
// Sale Create trusts them; purchasePrice/gstApplicable/gstPercent/
// hsnCode stay server-authoritative from ProductSerial + the current
// GstConfig, never client-trusted. priceDifference compares the two
// sides' finalAmount (already net of each side's own discount), not
// raw sellingPrice.
//
// No condition check, no P&L/Dashboard integration - still out of
// scope for this phase.
// ============================================================
export const createSaleExchangeController = async (req, res) => {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const { id } = req.params;
        const user = req.user;
        const {
            oldProductSerialId,
            newProductSerialId,
            newSellingPrice,
            newDiscount = 0,
            newComplimentary,
            settlementDetails,
        } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw buildValidationError("Invalid sale ID");
        }
        if (!oldProductSerialId || !mongoose.Types.ObjectId.isValid(oldProductSerialId)) {
            throw buildValidationError("A valid old product serial is required");
        }
        if (!newProductSerialId || !mongoose.Types.ObjectId.isValid(newProductSerialId)) {
            throw buildValidationError("A valid new product serial is required");
        }
        if (String(oldProductSerialId) === String(newProductSerialId)) {
            throw buildValidationError("The new unit must be different from the old unit");
        }

        const sale = await Sale.findOne({ _id: id, isDeleted: false }).session(session);
        if (!sale) {
            throw buildValidationError("Sale not found");
        }
        if (sale.status !== "COMPLETED") {
            throw buildValidationError(`Cannot process an exchange against a sale with status "${sale.status}"`);
        }

        // ============================================================
        // OLD ITEM - must be a real serialized line on this sale, and
        // its unit must still genuinely be SOLD under this sale (this
        // single check already rejects a unit that was already returned
        // OR already exchanged, since both flip status away from SOLD
        // and clear saleId - same eligibility check
        // updateSale.controller.js/createSaleReturn.controller.js use).
        // ============================================================
        const oldLine = sale.items.find(
            (it) => it.isSerialized && String(it.productSerialId) === String(oldProductSerialId)
        );
        if (!oldLine) {
            throw buildValidationError("The selected item does not belong to this sale");
        }

        const oldSerial = await ProductSerial.findOne({
            _id: oldProductSerialId,
            saleId: sale._id,
            status: "SOLD",
        }).session(session);
        if (!oldSerial) {
            throw buildValidationError(`Serial ${oldLine.serialNumber} has already been returned or exchanged elsewhere and can't be exchanged again.`);
        }

        // ============================================================
        // NEW ITEM - must be a real, available, serialized unit at this
        // sale's own branch, matching updateSale.controller.js's own
        // swap-validation exactly.
        // ============================================================
        const newSerial = await ProductSerial.findOne({
            _id: newProductSerialId,
            currentBranchId: sale.branchId,
            status: "AVAILABLE",
        }).session(session);
        if (!newSerial) {
            throw buildValidationError("The selected replacement unit is not available at this branch");
        }

        const newProduct = await Product.findOne({ _id: newSerial.productId, isDeleted: false }).session(session);
        if (!newProduct) throw buildValidationError("Product not found for the selected replacement unit");
        if (!newProduct.isSerialized) throw buildValidationError(`${newProduct.name} is not a serialized product`);
        if (!newProduct.hsnCode?.trim()) throw buildValidationError(`${newProduct.name} has no HSN/SAC code set on the product master`);

        // ============================================================
        // NEW ITEM FINANCIALS - same formula as createSale.controller.js's
        // serialized branch (subtotal -> discount -> taxable -> margin
        // GST -> finalAmount). purchasePrice/gstApplicable/gstPercent/
        // hsnCode come from the resolved unit + current GstConfig, never
        // the client; sellingPrice/discount/complimentary are the
        // staff's own entry, same trust model Sale Create uses.
        // ============================================================
        const newSellingPriceValue = Number(newSellingPrice);
        if (!newSellingPriceValue || newSellingPriceValue <= 0) {
            throw buildValidationError(`Selling price must be greater than 0 for ${newProduct.name}`);
        }
        const newDiscountValue = Number(newDiscount) || 0;
        if (newDiscountValue < 0) {
            throw buildValidationError(`Discount cannot be negative for ${newProduct.name}`);
        }

        const gstConfig = await getOrCreateGstConfig({ session });

        const newPurchasePrice = newSerial.purchasePrice || 0;
        const newGstApplicable = newSerial.gstApplicable || false;
        const newGstPercent = gstConfig.marginSchemeRate || 0;
        const newHsnCode = newSerial.hsnCode || newProduct.hsnCode || "";

        const newSubtotal = newSellingPriceValue;
        const newTaxable = round2(newSubtotal - newDiscountValue);
        if (newTaxable < 0) {
            throw buildValidationError(`Discount cannot exceed the selling price for ${newProduct.name}`);
        }
        const newProfit = newSellingPriceValue - newPurchasePrice - newDiscountValue;
        const newGstAmount = newGstApplicable && newGstPercent > 0 && newProfit > 0 ? round2((newProfit * newGstPercent) / 100) : 0;
        const newFinalAmount = newTaxable;

        const newComplimentaryValue = {
            bag: !!newComplimentary?.bag,
            hub: !!newComplimentary?.hub,
            msOffice: !!newComplimentary?.msOffice,
            case: !!newComplimentary?.case,
        };

        // Old item's financials are already fully computed and frozen on
        // the Sale's own line at sale time - reused as-is, never
        // recalculated here.
        const oldFinalAmount = oldLine.finalAmount ?? oldLine.sellingPrice ?? 0;

        // ============================================================
        // PRICE DIFFERENCE + SETTLEMENT - compares each side's finalAmount
        // (already net of its own discount), not raw sellingPrice.
        // ============================================================
        const priceDifference = round2(newFinalAmount - oldFinalAmount);
        const settlementType = priceDifference > 0 ? "CUSTOMER_PAYS" : priceDifference < 0 ? "COMPANY_REFUNDS" : "NONE";

        let validatedSettlementDetails = [];
        if (settlementType === "NONE") {
            if (Array.isArray(settlementDetails) && settlementDetails.length > 0) {
                throw buildValidationError("No settlement is needed when both prices are equal");
            }
        } else {
            if (!Array.isArray(settlementDetails) || settlementDetails.length === 0) {
                throw buildValidationError(
                    settlementType === "CUSTOMER_PAYS"
                        ? "Payment details are required since the customer owes the price difference"
                        : "Refund details are required since the company owes the price difference"
                );
            }
            validatedSettlementDetails = settlementDetails.map((s) => {
                const amount = Number(s.amount);
                if (!amount || amount <= 0) {
                    throw buildValidationError("Each settlement entry needs an amount greater than 0");
                }
                return {
                    amount,
                    date: s.date ? new Date(s.date) : new Date(),
                    method: s.method || "CASH",
                    notes: s.notes || "",
                    attachment: s.attachment || null,
                    handledBy: {
                        userId: user._id,
                        name: user.name || "",
                        role: user.role || "",
                    },
                };
            });
            const settlementSum = round2(validatedSettlementDetails.reduce((sum, s) => sum + s.amount, 0));
            if (settlementSum !== Math.abs(priceDifference)) {
                throw buildValidationError(
                    `Settlement total (${settlementSum}) must exactly match the price difference (${Math.abs(priceDifference)})`
                );
            }
        }

        // ============================================================
        // CREATE EXCHANGE RECORD
        // ============================================================
        const [exchangeDoc] = await SaleExchange.create(
            [
                {
                    saleId: sale._id,
                    saleNumber: sale.saleNumber,
                    branchId: sale.branchId,
                    oldItem: {
                        productId: oldLine.productId,
                        productName: oldLine.productName,
                        productCode: oldLine.productCode || "",
                        modelNumber: oldLine.modelNumber || "",
                        productSerialId: oldSerial._id,
                        serialNumber: oldSerial.serialNumber,
                        purchasePrice: oldLine.purchasePrice || 0,
                        sellingPrice: oldLine.sellingPrice || 0,
                        discount: oldLine.discount || 0,
                        subtotal: oldLine.subtotal || oldLine.sellingPrice || 0,
                        gstApplicable: oldLine.gstApplicable || false,
                        gstPercent: oldLine.gstPercent || 0,
                        gstAmount: oldLine.gstAmount || 0,
                        hsnCode: oldLine.hsnCode || "",
                        finalAmount: oldFinalAmount,
                        complimentary: {
                            bag: !!oldLine.complimentary?.bag,
                            hub: !!oldLine.complimentary?.hub,
                            msOffice: !!oldLine.complimentary?.msOffice,
                            case: !!oldLine.complimentary?.case,
                        },
                    },
                    newItem: {
                        productId: newSerial.productId,
                        productName: newProduct.name,
                        productCode: newProduct.productCode || "",
                        modelNumber: newProduct.modelNumber || "",
                        productSerialId: newSerial._id,
                        serialNumber: newSerial.serialNumber,
                        purchasePrice: newPurchasePrice,
                        sellingPrice: newSellingPriceValue,
                        discount: newDiscountValue,
                        subtotal: newSubtotal,
                        gstApplicable: newGstApplicable,
                        gstPercent: newGstApplicable ? newGstPercent : 0,
                        gstAmount: newGstAmount,
                        hsnCode: newHsnCode,
                        finalAmount: newFinalAmount,
                        complimentary: newComplimentaryValue,
                    },
                    priceDifference,
                    settlementType,
                    settlementDetails: validatedSettlementDetails,
                    exchangedAt: new Date(),
                    processStatus: user.role !== "SUPER_ADMIN" ? "PENDING_REVIEW" : null,
                    createdBy: user._id,
                },
            ],
            { session }
        );

        // ============================================================
        // APPLY STOCK - old unit back to AVAILABLE, new unit becomes SOLD
        // (soft-linked to this Sale so a future Return against it works
        // normally, even though sale.items itself is never touched).
        // ============================================================
        oldSerial.status = "AVAILABLE";
        oldSerial.soldAt = null;
        oldSerial.saleId = null;
        await oldSerial.save({ session });

        newSerial.status = "SOLD";
        newSerial.soldAt = new Date();
        newSerial.saleId = sale._id;
        await newSerial.save({ session });

        await recordStockMovement({
            type: "RETURN",
            productId: oldSerial.productId,
            branchId: sale.branchId,
            serialId: oldSerial._id,
            quantityDelta: 1,
            unitCost: oldSerial.purchasePrice,
            gstApplicable: oldSerial.gstApplicable,
            gstPercent: oldLine.purchaseGstPercent || 0,
            referenceType: "SaleExchange",
            referenceId: exchangeDoc._id,
            performedBy: user._id,
            performedByName: user.name || "",
            notes: `Serial ${oldSerial.serialNumber} exchanged out (against ${sale.saleNumber})`,
            session,
        });

        await recordStockMovement({
            type: "SALE",
            productId: newSerial.productId,
            branchId: sale.branchId,
            serialId: newSerial._id,
            quantityDelta: -1,
            unitCost: newSerial.purchasePrice,
            gstApplicable: newSerial.gstApplicable,
            gstPercent: newSerial.purchaseGstPercent || 0,
            referenceType: "SaleExchange",
            referenceId: exchangeDoc._id,
            performedBy: user._id,
            performedByName: user.name || "",
            notes: `Serial ${newSerial.serialNumber} exchanged in (against ${sale.saleNumber})`,
            session,
        });

        // ============================================================
        // EOD REVIEW RESET ON THE SALE ITSELF - same rule as
        // createSaleReturn.controller.js: an exchange is fresh activity
        // that needs SUPER_ADMIN's attention again.
        // ============================================================
        sale.processStatus = user.role !== "SUPER_ADMIN" ? "PENDING_REVIEW" : null;
        sale.reviewedBy = null;
        sale.reviewedAt = null;
        await sale.save({ session });

        await session.commitTransaction();
        session.endSession();

        const populatedExchange = await SaleExchange.findById(exchangeDoc._id).populate("createdBy", "name email");

        return successResponse(res, "Exchange processed successfully", { saleExchange: populatedExchange }, 201);
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Create Sale Exchange Error:", error);
        if (error.isValidation) {
            return errorResponse(res, error.message, 400);
        }
        return errorResponse(res, error.message || "Failed to process exchange", 500);
    }
};
