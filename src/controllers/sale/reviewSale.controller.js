// controllers/sale/reviewSale.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import SaleReturn from "../../models/SaleReturn.modal.js";
import SaleExchange from "../../models/SaleExchange.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// EOD (End of Day) audit review - SUPER_ADMIN marks a non-SUPER_ADMIN-
// created sale APPROVED or REJECTED purely for fraud/accountability
// verification, directly from the sale's own detail page. Deliberately
// touches ONLY processStatus/reviewedBy/reviewedAt - never stock,
// payment, invoice, or GST, all of which are already final by sale
// time. No re-review: once processStatus has moved off
// PENDING_REVIEW, this sale is done here.
//
// Create/Edit/Return/Exchange all share this ONE review action - there
// is no separate per-Return or per-Exchange approve/reject (see
// createSaleReturn.controller.js/createSaleExchange.controller.js, both
// of which reset sale.processStatus back to PENDING_REVIEW on every
// return/exchange). Approving/rejecting the sale here cascades the same
// decision to any of its own SaleReturn/SaleExchange docs still sitting
// at PENDING_REVIEW, so nothing is left permanently stuck once this
// sale itself has been reviewed.
export const reviewSaleController = async (req, res) => {
    try {
        const { id } = req.params;
        const { decision } = req.body;
        const user = req.user;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid sale ID", 400);
        }

        if (!["APPROVED", "REJECTED"].includes(decision)) {
            return errorResponse(res, "Decision must be APPROVED or REJECTED", 400);
        }

        const sale = await Sale.findOne({ _id: id, isDeleted: false });

        if (!sale) {
            return errorResponse(res, "Sale not found", 404);
        }

        if (sale.processStatus !== "PENDING_REVIEW") {
            return errorResponse(res, `This sale has already been reviewed (${sale.processStatus || "not part of EOD review"})`, 400);
        }

        const reviewedAt = new Date();

        await Sale.findByIdAndUpdate(id, {
            processStatus: decision,
            reviewedBy: user._id,
            reviewedAt,
        });

        await SaleReturn.updateMany(
            { saleId: id, isDeleted: false, processStatus: "PENDING_REVIEW" },
            { processStatus: decision, reviewedBy: user._id, reviewedAt }
        );

        await SaleExchange.updateMany(
            { saleId: id, isDeleted: false, processStatus: "PENDING_REVIEW" },
            { processStatus: decision, reviewedBy: user._id, reviewedAt }
        );

        return successResponse(res, `Sale ${decision.toLowerCase()} successfully`, {
            _id: id,
            processStatus: decision,
            reviewedBy: user._id,
            reviewedAt: new Date(),
        });
    } catch (error) {
        console.error("Review Sale Error:", error);
        return errorResponse(res, error.message || "Failed to review sale", 500);
    }
};
