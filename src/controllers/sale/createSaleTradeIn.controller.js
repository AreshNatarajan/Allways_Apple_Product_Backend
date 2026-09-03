// controllers/sale/createSaleTradeIn.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import SaleTradeIn from "../../models/SaleTradeIn.modal.js";
import Customer from "../../models/Customer.modal.js";
import { processTradeIn } from "../../services/sale/tradeInProcessor.service.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const buildValidationError = (message) => {
    const err = new Error(message);
    err.isValidation = true;
    return err;
};

// ============================================================
// Post-Sale Type 2 Exchange (Trade-In) - a customer trades in one or
// more old products AFTER a sale has already been completed, as credit
// against that sale's remaining balance. Reuses
// services/sale/tradeInProcessor.service.js UNCHANGED for the actual
// inventory-receiving side (same synthetic Purchase mechanism,
// source: "CUSTOMER_EXCHANGE") - exactly the function
// createSale.controller.js already calls for create-time trade-in.
//
// Unlike createSaleReturn.controller.js/createSaleExchange.controller.js
// (which deliberately never touch Sale.paidAmount/pendingAmount/
// paymentStatus), this DOES adjust pendingAmount/paymentStatus/
// tradeInCreditApplied - the trade-in's value is applied straight
// against whatever the sale still owes, same idea as create-time
// trade-in reducing payableAmount before payment is computed. If the
// trade-in is worth more than what's still owed (sale already fully
// paid, or trade-in exceeds the remaining due), the excess becomes a
// tracked refund-due amount (settlementType/settlementDetails),
// mirroring createSaleExchange.controller.js's own price-difference
// settlement pattern.
//
// Also unlike Return/Exchange's null-for-SUPER_ADMIN EOD review rule,
// a post-sale trade-in ALWAYS goes to PENDING_REVIEW, even when a
// SUPER_ADMIN processes it - both on this SaleTradeIn doc and on the
// Sale itself. Deliberate: this is new money movement happening well
// after the original sale was already reviewed, so it always needs a
// fresh look, regardless of who triggered it.
// ============================================================
export const createSaleTradeInController = async (req, res) => {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const { id } = req.params;
        const user = req.user;
        const { items, settlementDetails } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw buildValidationError("Invalid sale ID");
        }
        if (!Array.isArray(items) || items.length === 0) {
            throw buildValidationError("At least one trade-in item is required");
        }

        const sale = await Sale.findOne({ _id: id, isDeleted: false }).session(session);
        if (!sale) {
            throw buildValidationError("Sale not found");
        }
        if (sale.status !== "COMPLETED") {
            throw buildValidationError(`Cannot process a trade-in against a sale with status "${sale.status}"`);
        }

        const gstConfig = await getOrCreateGstConfig({ session });
        const customer = sale.customerId ? await Customer.findById(sale.customerId).session(session) : null;

        // ============================================================
        // RECEIVE INVENTORY - same call, same function, create-time
        // trade-in already uses. Throws/returns { error } the same way;
        // never modified for this post-sale path.
        // ============================================================
        const result = await processTradeIn({
            tradeInItems: items,
            branchId: sale.branchId,
            saleNumber: sale.saleNumber,
            customerName: customer?.name || "",
            gstConfig,
            user,
            session,
        });
        if (result.error) {
            throw buildValidationError(result.error);
        }
        const { tradeInItemsEmbed, purchaseId } = result;

        const totalValue = round2(
            tradeInItemsEmbed.reduce((sum, it) => sum + (it.isSerialized ? it.purchasePrice : it.purchasePrice * it.quantity), 0)
        );

        // ============================================================
        // APPLY TO PENDING BALANCE - credits off the sale's CURRENT
        // pendingAmount directly (not re-derived from totalAmount/
        // netPayableAmount), so this can never conflict with
        // updateSale.controller.js's own independent recompute.
        // ============================================================
        const appliedToPending = round2(Math.min(totalValue, sale.pendingAmount));
        const overageAmount = round2(totalValue - appliedToPending);
        const settlementType = overageAmount > 0 ? "COMPANY_REFUNDS" : "NONE";

        let validatedSettlementDetails = [];
        if (settlementType === "NONE") {
            if (Array.isArray(settlementDetails) && settlementDetails.length > 0) {
                throw buildValidationError("No refund settlement is needed when the trade-in doesn't exceed the pending amount");
            }
        } else {
            if (!Array.isArray(settlementDetails) || settlementDetails.length === 0) {
                throw buildValidationError("Refund details are required since the trade-in value exceeds the pending amount");
            }
            validatedSettlementDetails = settlementDetails.map((s) => {
                const amount = Number(s.amount);
                if (!amount || amount <= 0) {
                    throw buildValidationError("Each refund entry needs an amount greater than 0");
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
            if (settlementSum !== overageAmount) {
                throw buildValidationError(`Refund total (${settlementSum}) must exactly match the overage amount (${overageAmount})`);
            }
        }

        const [tradeInDoc] = await SaleTradeIn.create(
            [
                {
                    saleId: sale._id,
                    saleNumber: sale.saleNumber,
                    branchId: sale.branchId,
                    items: tradeInItemsEmbed,
                    totalValue,
                    tradeInPurchaseId: purchaseId,
                    appliedToPending,
                    overageAmount,
                    settlementType,
                    settlementDetails: validatedSettlementDetails,
                    tradeInAt: new Date(),
                    // Always PENDING_REVIEW, including for a SUPER_ADMIN-
                    // created trade-in - deliberately NOT the same
                    // role-based null-for-SUPER_ADMIN rule Return/Exchange
                    // still use elsewhere in this file's siblings. Matches
                    // the same always-PENDING_REVIEW rule already enforced
                    // for Sale create/edit.
                    processStatus: "PENDING_REVIEW",
                    createdBy: user._id,
                },
            ],
            { session }
        );

        // ============================================================
        // UPDATE THE SALE - pendingAmount/paymentStatus/
        // tradeInCreditApplied, plus the same EOD-review reset
        // Return/Exchange already apply on every post-sale action.
        // ============================================================
        sale.pendingAmount = round2(Math.max(0, sale.pendingAmount - appliedToPending));
        sale.tradeInCreditApplied = round2((sale.tradeInCreditApplied || 0) + appliedToPending);
        sale.paymentStatus = sale.pendingAmount === 0 ? "PAID" : (sale.paidAmount > 0 || sale.tradeInCreditApplied > 0 ? "PARTIAL" : "UNPAID");
        // Always PENDING_REVIEW - see the matching comment on the
        // SaleTradeIn doc's own processStatus above.
        sale.processStatus = "PENDING_REVIEW";
        sale.reviewedBy = null;
        sale.reviewedAt = null;
        await sale.save({ session });

        await session.commitTransaction();
        session.endSession();

        const populatedTradeIn = await SaleTradeIn.findById(tradeInDoc._id).populate("createdBy", "name email");

        return successResponse(res, "Trade-in processed successfully", { saleTradeIn: populatedTradeIn }, 201);
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Create Sale Trade-In Error:", error);
        if (error.isValidation) {
            return errorResponse(res, error.message, 400);
        }
        return errorResponse(res, error.message || "Failed to process trade-in", 500);
    }
};
