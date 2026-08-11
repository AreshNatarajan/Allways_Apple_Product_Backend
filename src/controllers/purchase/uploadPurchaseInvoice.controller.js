import crypto from "crypto";
import { validateInvoicePdf } from "../../middleware/uploadPurchaseInvoice.middleware.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

// Uploads the vendor's own supplier invoice PDF (the document they hand
// over, scanned/exported) - distinct from the system-generated invoice
// (services/purchase/generatePurchaseInvoicePdf.js), which is a separate
// PDF this app builds itself. This is a pre-upload endpoint (no purchase
// _id yet at the time the frontend calls it) - the returned S3 URL is
// stashed by the frontend and included by value in the createPurchase
// payload afterward, same pattern already used for the legacy
// signature/payment-evidence uploads.
export const uploadPurchaseInvoiceController = async (req, res) => {
    try {
        const file = req.files?.invoice;

        const validationError = validateInvoicePdf(file);
        if (validationError) {
            return errorResponse(res, validationError, 400);
        }

        const storageKey = `purchases/vendor-invoices/${Date.now()}-${crypto
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
        console.error("Invoice Upload Error:", error);
        return errorResponse(res, "Invoice upload failed", 500);
    }
};
