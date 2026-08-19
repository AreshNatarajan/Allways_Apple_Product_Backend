// controllers/purchase/reviewPurchase.controller.js
import mongoose from "mongoose";
import Purchase from "../../models/Purchase.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// EOD (End of Day) audit review - SUPER_ADMIN marks an edited purchase
// APPROVED or REJECTED purely for accountability verification, directly
// from the purchase's own detail page. Mirrors reviewSale.controller.js
// exactly. Deliberately touches ONLY processStatus/reviewedBy/
// reviewedAt - never items, inventory, or payment, all of which are
// already applied by updatePurchase.controller.js by the time this
// runs. No re-review: once processStatus has moved off
// PENDING_REVIEW, this purchase is done here (editing it again is what
// reopens review).
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

        if (purchase.processStatus !== "PENDING_REVIEW") {
            return errorResponse(res, `This purchase has already been reviewed (${purchase.processStatus || "not part of EOD review"})`, 400);
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
