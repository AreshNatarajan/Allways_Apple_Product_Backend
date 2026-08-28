// controllers/sale/createSaleReturn.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import SaleReturn from "../../models/SaleReturn.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Inventory from "../../models/Inventory.modal.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const buildValidationError = (message) => {
    const err = new Error(message);
    err.isValidation = true;
    return err;
};

// ============================================================
// Sale Return - a customer returns one or more already-sold items for
// a refund. Applies immediately (no pending-approval gate) - stock goes
// back to AVAILABLE at this sale's own branch and a StockMovement
// "RETURN" row is written right here, exactly like every other
// stock-affecting action in this app. The safety net is the SAME EOD
// review as everything else on this sale (see reviewSale.controller.js) -
// this resets sale.processStatus back to PENDING_REVIEW for a non-
// SUPER_ADMIN-created return, and that one review action (approve/
// reject the sale) also cascades to any of its own SaleReturn docs
// still pending - there is no separate per-Return review anymore.
// Mirrors updateSale.controller.js's
// existing item-removal reversal mechanics exactly (same field
// assignments), just parameterized by the RETURNED quantity instead of
// always the full line quantity, since a non-serialized line can be
// partially returned across multiple separate return events.
//
// The refund recorded here is deliberately independent of the Sale's
// own paidAmount/pendingAmount/paymentStatus - the Sale stays a frozen
// historical snapshot of what was actually sold and paid, matching how
// this app already treats every other financial record. Profit & Loss/
// Dashboard integration is a separate, later phase.
// ============================================================
export const createSaleReturnController = async (req, res) => {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const { id } = req.params;
        const user = req.user;
        const { items, reason, refundDetails } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw buildValidationError("Invalid sale ID");
        }
        if (!reason || !reason.trim()) {
            throw buildValidationError("A return reason is required");
        }
        if (!Array.isArray(items) || items.length === 0) {
            throw buildValidationError("At least one item is required to process a return");
        }
        if (!Array.isArray(refundDetails) || refundDetails.length === 0) {
            throw buildValidationError("At least one refund entry is required");
        }

        const sale = await Sale.findOne({ _id: id, isDeleted: false }).session(session);
        if (!sale) {
            throw buildValidationError("Sale not found");
        }
        if (sale.status !== "COMPLETED") {
            throw buildValidationError(`Cannot process a return against a sale with status "${sale.status}"`);
        }

        // Mirrors Sale.paymentDetails' own validation in
        // createSale.controller.js - amount required and > 0, method
        // restricted to the same enum, handledBy always stamped from
        // the authenticated user, never client-trusted.
        const validatedRefundDetails = refundDetails.map((r) => {
            const amount = Number(r.amount);
            if (!amount || amount <= 0) {
                throw buildValidationError("Each refund entry needs an amount greater than 0");
            }
            return {
                amount,
                refundDate: r.refundDate ? new Date(r.refundDate) : new Date(),
                refundMethod: r.refundMethod || "CASH",
                notes: r.notes || "",
                attachment: r.attachment || null,
                handledBy: {
                    userId: user._id,
                    name: user.name || "",
                    role: user.role || "",
                },
            };
        });
        const refundAmount = round2(validatedRefundDetails.reduce((sum, r) => sum + r.amount, 0));

        // Quantity already returned per batch line, across every prior
        // non-REJECTED return of this sale (a REJECTED return never
        // applied stock/refund, so it doesn't count against the
        // remaining returnable balance). Keyed by batchId - a
        // Sale.items line has no subdocument _id (saleItemSchema is
        // `{ _id: false }`), and a batchId is already unique per line
        // within one Sale (see Sale.modal.js's own comment), matching
        // how updateSale.controller.js's removedItems.nonSerialized
        // already identifies a line the same way.
        const priorReturns = await SaleReturn.find({
            saleId: sale._id,
            isDeleted: false,
            processStatus: { $ne: "REJECTED" },
        }).session(session);
        const alreadyReturnedByBatchId = new Map();
        for (const priorReturn of priorReturns) {
            for (const line of priorReturn.items) {
                if (line.isSerialized) continue;
                const key = String(line.batchId);
                alreadyReturnedByBatchId.set(key, (alreadyReturnedByBatchId.get(key) || 0) + line.quantity);
            }
        }

        const returnItems = [];
        const serialsToRelease = [];
        const batchLinesToRelease = [];

        // Each requested line identifies EITHER a serialized unit
        // (productSerialId) OR a non-serialized batch line (batchId +
        // quantity) - never both, matching the exact same discriminated
        // shape Sale.items itself already uses.
        for (const requested of items) {
            if (requested.productSerialId) {
                const saleLine = sale.items.find(
                    (it) => it.isSerialized && String(it.productSerialId) === String(requested.productSerialId)
                );
                if (!saleLine) {
                    throw buildValidationError("One of the selected serials no longer belongs to this sale");
                }

                const serial = await ProductSerial.findOne({
                    _id: saleLine.productSerialId,
                    saleId: sale._id,
                    status: "SOLD",
                }).session(session);
                if (!serial) {
                    throw buildValidationError(`Serial ${saleLine.serialNumber} has already been returned or reconciled elsewhere and can't be returned again.`);
                }

                const unitPrice = saleLine.sellingPrice || 0;
                // Only an accessory actually given at sale time
                // (sale.items[].complimentary) can be marked returned -
                // a requested checkbox for something never given is
                // silently ignored rather than trusted at face value.
                const givenAtSale = saleLine.complimentary || {};
                const requestedComplimentary = requested.complimentaryReturned || {};
                const complimentaryReturned = {
                    bag: !!givenAtSale.bag && !!requestedComplimentary.bag,
                    hub: !!givenAtSale.hub && !!requestedComplimentary.hub,
                    msOffice: !!givenAtSale.msOffice && !!requestedComplimentary.msOffice,
                    case: !!givenAtSale.case && !!requestedComplimentary.case,
                };
                returnItems.push({
                    productId: saleLine.productId,
                    productName: saleLine.productName,
                    isSerialized: true,
                    productSerialId: saleLine.productSerialId,
                    serialNumber: saleLine.serialNumber,
                    quantity: 1,
                    unitPrice,
                    lineRefundAmount: round2(unitPrice),
                    complimentaryReturned,
                });
                serialsToRelease.push(serial);
            } else if (requested.batchId) {
                const saleLine = sale.items.find(
                    (it) => !it.isSerialized && String(it.batchId) === String(requested.batchId)
                );
                if (!saleLine) {
                    throw buildValidationError("One of the selected items no longer belongs to this sale");
                }

                const requestedQty = Number(requested.quantity) || 0;
                if (requestedQty < 1) {
                    throw buildValidationError(`Return quantity for ${saleLine.productName} must be at least 1`);
                }

                const alreadyReturned = alreadyReturnedByBatchId.get(String(saleLine.batchId)) || 0;
                const remaining = saleLine.quantity - alreadyReturned;
                if (requestedQty > remaining) {
                    throw buildValidationError(
                        `Only ${remaining} unit(s) of ${saleLine.productName} (Batch ${saleLine.batchNumber}) remain returnable`
                    );
                }
                alreadyReturnedByBatchId.set(String(saleLine.batchId), alreadyReturned + requestedQty);

                const batchStock = await BatchStock.findOne({
                    batchId: saleLine.batchId,
                    productId: saleLine.productId,
                    branchId: sale.branchId,
                }).session(session);
                if (!batchStock) {
                    throw buildValidationError(`Batch ${saleLine.batchNumber} not found for this branch`);
                }

                const unitPrice = saleLine.sellingPrice || 0;
                returnItems.push({
                    productId: saleLine.productId,
                    productName: saleLine.productName,
                    isSerialized: false,
                    batchId: saleLine.batchId,
                    batchNumber: saleLine.batchNumber,
                    quantity: requestedQty,
                    unitPrice,
                    lineRefundAmount: round2(unitPrice * requestedQty),
                });
                batchLinesToRelease.push({ saleLine, batchStock, quantity: requestedQty });
            } else {
                throw buildValidationError("Each return line must include either productSerialId or batchId");
            }
        }

        const [saleReturnDoc] = await SaleReturn.create(
            [
                {
                    saleId: sale._id,
                    saleNumber: sale.saleNumber,
                    branchId: sale.branchId,
                    items: returnItems,
                    reason: reason.trim(),
                    refundAmount,
                    refundDetails: validatedRefundDetails,
                    processStatus: user.role !== "SUPER_ADMIN" ? "PENDING_REVIEW" : null,
                    createdBy: user._id,
                },
            ],
            { session }
        );

        // ============================================================
        // EOD REVIEW RESET ON THE SALE ITSELF - a return is treated as
        // fresh activity on this sale that needs SUPER_ADMIN's attention
        // again, exactly like updateSale.controller.js already resets
        // review on every edit. A SUPER_ADMIN's own return needs no one
        // to review them (processStatus goes back to null, out of EOD
        // scope entirely), same rule as an edit.
        // ============================================================
        sale.processStatus = user.role !== "SUPER_ADMIN" ? "PENDING_REVIEW" : null;
        sale.reviewedBy = null;
        sale.reviewedAt = null;
        await sale.save({ session });

        // =====================
        // APPLY - serialized: back to AVAILABLE at this sale's branch.
        // =====================
        for (const serial of serialsToRelease) {
            serial.status = "AVAILABLE";
            serial.soldAt = null;
            serial.saleId = null;
            await serial.save({ session });

            await recordStockMovement({
                type: "RETURN",
                productId: serial.productId,
                branchId: sale.branchId,
                serialId: serial._id,
                quantityDelta: 1,
                unitCost: serial.purchasePrice,
                gstApplicable: serial.gstApplicable,
                gstPercent: serial.purchaseGstPercent,
                referenceType: "SaleReturn",
                referenceId: saleReturnDoc._id,
                performedBy: user._id,
                performedByName: user.name || "",
                notes: `Serial ${serial.serialNumber} returned against ${sale.saleNumber}`,
                session,
            });
        }

        // =====================
        // APPLY - non-serialized: increment availableQuantity/decrement
        // soldQuantity, mirroring updateSale.controller.js's own
        // item-removal reversal exactly.
        // =====================
        for (const { saleLine, batchStock, quantity } of batchLinesToRelease) {
            batchStock.availableQuantity += quantity;
            batchStock.soldQuantity = Math.max(0, batchStock.soldQuantity - quantity);
            if (batchStock.status === "EXHAUSTED" && batchStock.availableQuantity > 0) {
                batchStock.status = "ACTIVE";
            }
            await batchStock.save({ session });

            const inventory = await Inventory.findOne({ productId: saleLine.productId, branchId: sale.branchId }).session(session);
            if (inventory) {
                inventory.quantity += quantity;
                await inventory.save({ session });
            }

            await recordStockMovement({
                type: "RETURN",
                productId: saleLine.productId,
                branchId: sale.branchId,
                batchId: saleLine.batchId,
                quantityDelta: quantity,
                resultingAvailableQuantity: batchStock.availableQuantity,
                unitCost: saleLine.purchasePrice,
                gstApplicable: saleLine.gstApplicable,
                gstPercent: saleLine.gstPercent,
                referenceType: "SaleReturn",
                referenceId: saleReturnDoc._id,
                performedBy: user._id,
                performedByName: user.name || "",
                notes: `${quantity} unit(s) of batch ${saleLine.batchNumber} returned against ${sale.saleNumber}`,
                session,
            });
        }

        await session.commitTransaction();
        session.endSession();

        const populatedReturn = await SaleReturn.findById(saleReturnDoc._id).populate("createdBy", "name email");

        return successResponse(res, "Return processed successfully", { saleReturn: populatedReturn }, 201);
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Create Sale Return Error:", error);
        if (error.isValidation) {
            return errorResponse(res, error.message, 400);
        }
        return errorResponse(res, error.message || "Failed to process return", 500);
    }
};
