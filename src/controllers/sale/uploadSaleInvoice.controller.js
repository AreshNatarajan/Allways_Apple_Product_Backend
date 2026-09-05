import crypto from "crypto";
import { validateInvoicePdf } from "../../middleware/uploadPurchaseInvoice.middleware.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Uploads the system-generated Sale invoice PDF (rendered client-side
// from src/utils/Template/Invoice.jsx and converted to a PDF via
// html2canvas + jsPDF - see the frontend's generateSaleInvoicePdf.js)
// to S3. Called AFTER the sale itself already exists (unlike Purchase's
// vendor-invoice upload, which is a pre-upload staging endpoint) - the
// caller stashes the returned URL and persists it via
// PATCH /sale/:id/invoice (see setSaleInvoiceFile.controller.js)
// immediately afterward.
//
// Reuses validateInvoicePdf from the Purchase upload middleware as-is -
// that validation (must be a PDF, <=10MB) has nothing Purchase-specific
// about it, same as uploadPaymentEvidenceController is already shared
// across Purchase/Sale.
export const uploadSaleInvoiceController = async (req, res) => {
    try {
        const file = req.files?.invoice;

        const validationError = validateInvoicePdf(file);
        if (validationError) {
            return errorResponse(res, validationError, 400);
        }

        const storageKey = `sales/invoices/${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.pdf`;

        const { url } = await putObject(file.data, storageKey, file.mimetype);

        return successResponse(
            res,
            "Invoice uploaded successfully",
            {
                invoice: url,
                originalName: file.name,
                size: file.size,
            }
        );

    } catch (error) {
        console.error("Sale Invoice Upload Error:", error);
        return errorResponse(res, "Invoice upload failed", 500);
    }
};
