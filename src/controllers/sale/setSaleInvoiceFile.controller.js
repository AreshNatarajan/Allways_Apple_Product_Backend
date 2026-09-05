// controllers/sale/setSaleInvoiceFile.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Persists the client-generated system invoice's S3 URL onto the sale -
// deliberately its own narrow endpoint rather than routed through
// PUT /sale/:id (updateSaleController), which recomputes payments/stock/
// EOD review and would be a much bigger blast radius for setting one
// field. Touches ONLY systemInvoiceFile, nothing else - no review reset,
// no recompute, matching this project's existing narrow-endpoint
// convention (see reviewSaleController's equally narrow scope).
//
// Same "invoiced exactly once" guard the old server-side generator used
// to enforce (generateSaleInvoicePdf.js, now removed) - a sale is never
// re-invoiced or overwritten once systemInvoiceFile is set.
export const setSaleInvoiceFileController = async (req, res) => {
    try {
        const { id } = req.params;
        const { systemInvoiceFile } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid sale ID", 400);
        }
        if (!systemInvoiceFile || typeof systemInvoiceFile !== "string") {
            return errorResponse(res, "A valid invoice URL is required", 400);
        }

        const sale = await Sale.findOne({ _id: id, isDeleted: false });
        if (!sale) {
            return errorResponse(res, "Sale not found", 404);
        }
        if (sale.systemInvoiceFile) {
            return errorResponse(res, "This sale already has a system invoice - it cannot be regenerated or overwritten.", 400);
        }

        sale.systemInvoiceFile = systemInvoiceFile;
        await sale.save();

        return successResponse(res, "System invoice saved successfully", {
            _id: sale._id,
            systemInvoiceFile: sale.systemInvoiceFile,
        });
    } catch (error) {
        console.error("Set Sale Invoice File Error:", error);
        return errorResponse(res, "Failed to save system invoice", 500);
    }
};
