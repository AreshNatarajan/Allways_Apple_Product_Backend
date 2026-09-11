// controllers/purchase/getPurchaseReturns.controller.js
import mongoose from "mongoose";
import PurchaseReturn from "../../models/PurchaseReturn.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// All returns processed against one Purchase - powers the Purchase
// Detail page's PurchaseReturnsCard. Same openness as GET /purchase/:id
// itself (no additional gate beyond being logged in), mirrors
// getSaleReturns.controller.js exactly.
export const getPurchaseReturnsController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid purchase ID", 400);
        }

        const returns = await PurchaseReturn.find({ purchaseId: id, isDeleted: false })
            .sort({ createdAt: -1 })
            .populate("createdBy", "name email")
            .populate("reviewedBy", "name email");

        return successResponse(res, "Purchase returns fetched successfully", { returns });
    } catch (error) {
        console.error("Get Purchase Returns Error:", error);
        return errorResponse(res, "Failed to fetch purchase returns", 500);
    }
};
