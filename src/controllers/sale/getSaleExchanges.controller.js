// controllers/sale/getSaleExchanges.controller.js
import mongoose from "mongoose";
import SaleExchange from "../../models/SaleExchange.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// All exchanges processed against one Sale - powers the Sale Detail
// page's ExchangesCard. Same openness as GET /sale/:id itself (no
// additional gate beyond being logged in).
export const getSaleExchangesController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid sale ID", 400);
        }

        const exchanges = await SaleExchange.find({ saleId: id, isDeleted: false })
            .sort({ createdAt: -1 })
            .populate("createdBy", "name email")
            .populate("reviewedBy", "name email");

        return successResponse(res, "Sale exchanges fetched successfully", { exchanges });
    } catch (error) {
        console.error("Get Sale Exchanges Error:", error);
        return errorResponse(res, "Failed to fetch sale exchanges", 500);
    }
};
