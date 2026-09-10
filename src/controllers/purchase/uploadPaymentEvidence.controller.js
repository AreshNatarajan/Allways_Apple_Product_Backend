import crypto from "crypto";
import {
    validateImageFile,
    resolveImageExtension,
} from "../../middleware/uploadUserImage.middleware.js";
import { convertImageForStorage } from "../../services/image/convertImageForStorage.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

// Payment evidence (proof of a non-cash payment - UPI/card/bank transfer
// screenshot, cheque photo, etc). This used to be a route-level multer
// instance writing to local disk, which - same as the vendor-invoice
// upload before it was fixed - never actually worked: express-fileupload
// is mounted globally in server.js and consumes the multipart body
// before multer gets a chance, always failing with "Unexpected end of
// form". Fixed to the same express-fileupload + S3 pattern used
// everywhere else in this app (branch logo, profile image, product
// images, vendor invoice).
export const uploadPaymentEvidenceController = async (req, res) => {
    try {
        const file = req.files?.payment;

        const validationError = validateImageFile(file);
        if (validationError) {
            return errorResponse(res, validationError, 400);
        }

        let converted;
        try {
            converted = await convertImageForStorage(file, resolveImageExtension(file));
        } catch (conversionError) {
            console.error("HEIC conversion error:", conversionError);
            return errorResponse(res, "Could not process this image - the file may be corrupted", 400);
        }

        const storageKey = `purchases/payment-evidence/${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.${converted.extension}`;

        const { url } = await putObject(converted.data, storageKey, converted.mimetype);

        return successResponse(
            res,
            "Payment evidence uploaded successfully",
            {
                paymentEvidence: url,
                originalName: file.name,
                size: file.size,
            }
        );

    } catch (error) {
        console.error("Payment Evidence Upload Error:", error);
        return errorResponse(res, "Payment evidence upload failed", 500);
    }
};
