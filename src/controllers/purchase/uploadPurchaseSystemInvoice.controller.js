import crypto from "crypto";
import { validateInvoicePdf } from "../../middleware/uploadPurchaseInvoice.middleware.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Uploads the SYSTEM-generated Purchase invoice PDF (rendered client-side
// from src/utils/Template/PurchaseInvoice.jsx via html2canvas + jsPDF -
// see the frontend's generatePurchaseInvoicePdf.js) to S3. Distinct from
// uploadPurchaseInvoiceController, which stages the VENDOR's own
// uploaded invoice file before a purchase even exists - this one is
// called on-demand, after the purchase already exists (PurchaseDetail's
// own "Create Invoice"/"Regenerate Invoice" action), same shape as
// Sale's uploadSaleInvoiceController. The caller stashes the returned
// URL and persists it via PATCH /purchase/:id/invoice (see
// setPurchaseInvoiceFile.controller.js) immediately afterward.
export const uploadPurchaseSystemInvoiceController = async (req, res) => {
    try {
        const file = req.files?.invoice;

        const validationError = validateInvoicePdf(file);
        if (validationError) {
            return errorResponse(res, validationError, 400);
        }

        const storageKey = `purchases/invoices/${Date.now()}-${crypto
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
        console.error("Purchase System Invoice Upload Error:", error);
        return errorResponse(res, "Invoice upload failed", 500);
    }
};
