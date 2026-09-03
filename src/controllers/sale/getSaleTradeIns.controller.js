// controllers/sale/getSaleTradeIns.controller.js
import mongoose from "mongoose";
import SaleTradeIn from "../../models/SaleTradeIn.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// All post-sale trade-ins processed against one Sale - powers the Sale
// Detail page's TradeInsCard. Same openness as GET /sale/:id itself (no
// additional gate beyond being logged in), matching
// getSaleReturns.controller.js/getSaleExchanges.controller.js.
export const getSaleTradeInsController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid sale ID", 400);
        }

        const tradeIns = await SaleTradeIn.find({ saleId: id, isDeleted: false })
            .sort({ createdAt: -1 })
            .populate("createdBy", "name email")
            .populate("reviewedBy", "name email");

        return successResponse(res, "Sale trade-ins fetched successfully", { tradeIns });
    } catch (error) {
        console.error("Get Sale Trade-Ins Error:", error);
        return errorResponse(res, "Failed to fetch sale trade-ins", 500);
    }
};
