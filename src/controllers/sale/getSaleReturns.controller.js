// controllers/sale/getSaleReturns.controller.js
import mongoose from "mongoose";
import SaleReturn from "../../models/SaleReturn.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// All returns processed against one Sale - powers the Sale Detail
// page's ReturnsCard. Same openness as GET /sale/:id itself (no
// additional gate beyond being logged in).
export const getSaleReturnsController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid sale ID", 400);
        }

        const returns = await SaleReturn.find({ saleId: id, isDeleted: false })
            .sort({ createdAt: -1 })
            .populate("createdBy", "name email")
            .populate("reviewedBy", "name email");

        return successResponse(res, "Sale returns fetched successfully", { returns });
    } catch (error) {
        console.error("Get Sale Returns Error:", error);
        return errorResponse(res, "Failed to fetch sale returns", 500);
    }
};
