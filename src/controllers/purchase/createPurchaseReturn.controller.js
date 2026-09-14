// controllers/purchase/createPurchaseReturn.controller.js
import mongoose from "mongoose";
import crypto from "crypto";
import Purchase from "../../models/Purchase.modal.js";
import PurchaseReturn from "../../models/PurchaseReturn.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Branch from "../../models/Branch.modal.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { generateDocumentNumber } from "../../services/documentNumber.service.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const buildValidationError = (message) => {
    const err = new Error(message);
    err.isValidation = true;
    return err;
};

// ============================================================
// Purchase Return - one or more already-purchased items sent back to
// the vendor. Mirrors createSaleReturn.controller.js's architecture
// exactly: applies IMMEDIATELY (no pending-approval gate) - the
// returned unit(s) leave sellable stock and the refund is recorded
// right here, in this same transaction. The safety net is the SAME EOD
// review as everything else on this purchase (see
// reviewPurchase.controller.js, which cascades its decision to every
// PENDING_REVIEW PurchaseReturn on this purchase) - there is no
// separate per-return review action.
//
// Direction is the mirror image of Sale Return: a Sale Return takes an
// item back FROM the customer (stock increases); a Purchase Return
// sends an item back TO the vendor (stock decreases). The refund flows
// the other way too - the vendor refunds US, not the other way around -
// but the refundDetails shape/validation is identical.
//
// One deliberate divergence from createSaleReturn.controller.js:
// processStatus here is UNCONDITIONALLY "PENDING_REVIEW", never null
// even for a SUPER_ADMIN creator - matches updatePurchase.controller.js's
// own "no one's own record is auto-approved" rule (a SUPER_ADMIN's edit
// already forces review there), rather than SaleReturn's
// role !== SUPER_ADMIN exemption.
// ============================================================
export const createPurchaseReturnController = async (req, res) => {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const user = req.user;
        const { id: purchaseId } = req.params;
        const { branchId, items, reason, refundDetails } = req.body;

        if (!mongoose.Types.ObjectId.isValid(purchaseId)) {
            throw buildValidationError("Invalid purchase ID");
        }
        if (!mongoose.Types.ObjectId.isValid(branchId)) {
            throw buildValidationError("A branch is required");
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

        if (user.role !== "SUPER_ADMIN" && String(user.branchId) !== String(branchId)) {
            throw buildValidationError("You can only return items from your own branch's stock");
        }

        const purchase = await Purchase.findOne({ _id: purchaseId, isDeleted: false }).session(session);
        if (!purchase) {
            throw buildValidationError("Purchase not found");
        }
        if (purchase.status !== "COMPLETED") {
            throw buildValidationError(`Cannot process a return against a purchase with status "${purchase.status}"`);
        }

        const branch = await Branch.findOne({ _id: branchId, isDeleted: false }).session(session);
        if (!branch) {
            throw buildValidationError("Branch not found");
        }

        // Mirrors Purchase.paymentDetails' own validation - amount
        // required and > 0, method restricted to the same enum,
        // handledBy always stamped from the authenticated user, never
        // client-trusted.
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
                attachments: Array.isArray(r.attachments)
                    ? r.attachments
                        .filter((a) => a && typeof a.url === "string" && a.url.trim())
                        .map((a) => ({
                            url: a.url.trim(),
                            key: typeof a.key === "string" ? a.key.trim() : null,
                            name: typeof a.name === "string" ? a.name.trim().slice(0, 200) : "",
                        }))
                    : [],
                handledBy: {
                    userId: user._id,
                    name: user.name || "",
                    role: user.role || "",
                },
            };
        });
        const refundAmount = round2(validatedRefundDetails.reduce((sum, r) => sum + r.amount, 0));

        const returnItems = [];
        const serialsToReturn = [];
        const batchLinesToReturn = [];

        // Each requested line identifies EITHER a serialized unit
        // (productSerialId) OR a non-serialized batch line (batchId +
        // quantity) - never both. Eligibility is checked against LIVE
        // state (ProductSerial.status / BatchStock.availableQuantity)
        // since this applies immediately - no separate "pending"
        // reservation bookkeeping is needed the way a two-phase
        // approve/reject flow would require.
        for (const requested of items) {
            if (requested.productSerialId) {
                const serial = await ProductSerial.findOne({
                    _id: requested.productSerialId,
                    purchaseId: purchase._id,
                    isDeleted: false,
                }).session(session);
                if (!serial) {
                    throw buildValidationError("One of the selected serials does not belong to this purchase");
                }
                if (serial.status !== "AVAILABLE") {
                    throw buildValidationError(
                        `Serial ${serial.serialNumber} is not eligible for return (current status: ${serial.status}). Only units still in available stock can be returned to the vendor.`
                    );
                }
                if (String(serial.currentBranchId) !== String(branchId)) {
                    throw buildValidationError(`Serial ${serial.serialNumber} is not currently at the selected branch and cannot be returned from here.`);
                }

                const unitPrice = serial.purchasePrice || 0;
                returnItems.push({
                    productId: serial.productId,
                    productName: requested.productName || "",
                    isSerialized: true,
                    productSerialId: serial._id,
                    serialNumber: serial.serialNumber,
                    quantity: 1,
                    unitPrice,
                    lineReturnAmount: round2(unitPrice),
                });
                serialsToReturn.push(serial);
            } else if (requested.batchId) {
                const requestedQty = Number(requested.quantity) || 0;
                if (requestedQty < 1) {
                    throw buildValidationError("Return quantity must be at least 1");
                }

                const batchStock = await BatchStock.findOne({
                    batchId: requested.batchId,
                    branchId,
                    purchaseId: purchase._id,
                }).session(session);
                if (!batchStock) {
                    throw buildValidationError("One of the selected batches does not belong to this purchase at the selected branch");
                }
                if (batchStock.availableQuantity < requestedQty) {
                    throw buildValidationError(
                        `Only ${batchStock.availableQuantity} unit(s) of batch ${batchStock.batchNumber} remain available for return`
                    );
                }

                const unitPrice = batchStock.purchasePrice || 0;
                returnItems.push({
                    productId: batchStock.productId,
                    productName: requested.productName || "",
                    isSerialized: false,
                    batchId: batchStock.batchId,
                    batchNumber: batchStock.batchNumber,
                    quantity: requestedQty,
                    unitPrice,
                    lineReturnAmount: round2(unitPrice * requestedQty),
                });
                batchLinesToReturn.push({ batchStock, quantity: requestedQty });
            } else {
                throw buildValidationError("Each return line must include either productSerialId or batchId");
            }
        }

        const returnAmount = round2(returnItems.reduce((sum, i) => sum + i.lineReturnAmount, 0));

        const gstConfigForNumber = await getOrCreateGstConfig({ session });
        const purchaseReturnNumber = await generateDocumentNumber(
            "purchaseReturn",
            gstConfigForNumber.documentPrefixes.purchaseReturn,
            { session }
        );

        const [purchaseReturnDoc] = await PurchaseReturn.create(
            [
                {
                    purchaseReturnNumber,
                    purchaseId: purchase._id,
                    purchaseNumber: purchase.purchaseNumber,
                    vendorId: purchase.vendorId,
                    vendorSnapshot: purchase.vendorSnapshot,
                    branchId,
                    branchName: branch.name,
                    items: returnItems,
                    reason: reason.trim(),
                    returnAmount,
                    refundAmount,
                    refundDetails: validatedRefundDetails,
                    // Unconditional, regardless of creator role - matches
                    // updatePurchase.controller.js's own "no one's own
                    // record is auto-approved" rule exactly (a SUPER_ADMIN
                    // edit already forces PENDING_REVIEW there; a
                    // SUPER_ADMIN-created return must too, not skip
                    // review the way createSaleReturn.controller.js's
                    // conditional pattern does). A different SUPER_ADMIN
                    // still has to come back and explicitly approve it.
                    processStatus: "PENDING_REVIEW",
                    createdBy: user._id,
                    createdByName: user.name || "",
                },
            ],
            { session }
        );

        // ============================================================
        // EOD REVIEW RESET ON THE PURCHASE ITSELF - a return is treated
        // as fresh activity on this purchase that needs SUPER_ADMIN's
        // attention again, exactly like updatePurchase.controller.js
        // resets review on every edit (unconditionally, including the
        // editor's/returner's own SUPER_ADMIN actions).
        // ============================================================
        purchase.processStatus = "PENDING_REVIEW";
        purchase.reviewedBy = null;
        purchase.reviewedAt = null;
        await purchase.save({ session });

        // =====================
        // APPLY - serialized: permanently removed from sellable stock.
        // =====================
        for (const serial of serialsToReturn) {
            serial.status = "RETURNED_TO_VENDOR";
            serial.returnedToVendorAt = new Date();
            serial.purchaseReturnId = purchaseReturnDoc._id;
            await serial.save({ session });

            await recordStockMovement({
                type: "PURCHASE_RETURN",
                productId: serial.productId,
                branchId,
                serialId: serial._id,
                quantityDelta: -1,
                unitCost: serial.purchasePrice,
                gstApplicable: serial.gstApplicable,
                gstPercent: serial.purchaseGstPercent,
                referenceType: "PurchaseReturn",
                referenceId: purchaseReturnDoc._id,
                performedBy: user._id,
                performedByName: user.name || "",
                notes: `Serial ${serial.serialNumber} returned to vendor against ${purchaseReturnNumber}`,
                session,
            });
        }

        // =====================
        // APPLY - non-serialized: available stock reduced, never below 0.
        // =====================
        for (const { batchStock, quantity } of batchLinesToReturn) {
            batchStock.availableQuantity -= quantity;
            batchStock.returnedQuantity = (batchStock.returnedQuantity || 0) + quantity;
            if (batchStock.availableQuantity <= 0) {
                batchStock.availableQuantity = 0;
                batchStock.status = "EXHAUSTED";
            }
            await batchStock.save({ session });

            await recordStockMovement({
                type: "PURCHASE_RETURN",
                productId: batchStock.productId,
                branchId,
                batchId: batchStock.batchId,
                quantityDelta: -quantity,
                resultingAvailableQuantity: batchStock.availableQuantity,
                unitCost: batchStock.purchasePrice,
                gstApplicable: batchStock.gstApplicable,
                gstPercent: batchStock.purchaseGstPercent,
                referenceType: "PurchaseReturn",
                referenceId: purchaseReturnDoc._id,
                performedBy: user._id,
                performedByName: user.name || "",
                notes: `${quantity} unit(s) of batch ${batchStock.batchNumber} returned to vendor against ${purchaseReturnNumber}`,
                session,
            });
        }

        await session.commitTransaction();
        session.endSession();

        const populatedReturn = await PurchaseReturn.findById(purchaseReturnDoc._id)
            .populate("createdBy", "name email")
            .populate("reviewedBy", "name email");

        return successResponse(res, "Return processed successfully", { purchaseReturn: populatedReturn }, 201);
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Create Purchase Return Error:", error);
        if (error.isValidation) {
            return errorResponse(res, error.message, 400);
        }
        return errorResponse(res, error.message || "Failed to process return", 500);
    }
};
