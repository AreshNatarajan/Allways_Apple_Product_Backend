// controllers/purchase/reviewPurchase.controller.js
import mongoose from "mongoose";
import Purchase from "../../models/Purchase.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// EOD (End of Day) audit review - SUPER_ADMIN marks a BRANCH purchase
// APPROVED or REJECTED purely for fraud/accountability verification.
// Deliberately touches ONLY processStatus/reviewedBy/reviewedAt - never
// inventory, payment, invoice, or GST, all of which are already final by
// purchase time (see the "EOD must not trigger..." rule in the spec).
// No re-review: once processStatus has moved off PENDING_REVIEW, this
// purchase is done here.
export const reviewPurchaseController = async (req, res) => {
    try {
        const { id } = req.params;
        const { decision } = req.body;
        const user = req.user;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid purchase ID", 400);
        }

        if (!["APPROVED", "REJECTED"].includes(decision)) {
            return errorResponse(res, "Decision must be APPROVED or REJECTED", 400);
        }

        const purchase = await Purchase.findOne({ _id: id, isDeleted: false });

        if (!purchase) {
            return errorResponse(res, "Purchase not found", 404);
        }

        if (purchase.poType !== "BRANCH") {
            return errorResponse(res, "Only branch purchases are part of EOD review", 400);
        }

        if (purchase.processStatus !== "PENDING_REVIEW") {
            return errorResponse(res, `This purchase has already been reviewed (${purchase.processStatus})`, 400);
        }

        await Purchase.findByIdAndUpdate(id, {
            processStatus: decision,
            reviewedBy: user._id,
            reviewedAt: new Date(),
        });

        return successResponse(res, `Purchase ${decision.toLowerCase()} successfully`, {
            _id: id,
            processStatus: decision,
            reviewedBy: user._id,
            reviewedAt: new Date(),
        });
    } catch (error) {
        console.error("Review Purchase Error:", error);
        return errorResponse(res, error.message || "Failed to review purchase", 500);
    }
};
