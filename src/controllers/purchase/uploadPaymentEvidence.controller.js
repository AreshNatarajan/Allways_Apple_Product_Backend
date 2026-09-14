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
//
// Accepts one OR more files under the same `payment` field (mirrors
// uploadProductSerialStagingImagesController's multi-file convention) -
// a single payment row can now carry several evidence files (e.g. two
// separate UPI screenshots for two transactions that together make up
// one logged payment amount, instead of forcing a whole extra payment
// row per screenshot). Returns an `evidence` array - always append
// every entry to the row's existing `attachments[]`, never replace it,
// since a row can accumulate evidence across several uploads.
export const uploadPaymentEvidenceController = async (req, res) => {
    try {
        const rawFiles = req.files?.payment;
        if (!rawFiles) {
            return errorResponse(res, "No file(s) uploaded", 400);
        }
        const files = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

        for (const file of files) {
            const validationError = validateImageFile(file);
            if (validationError) {
                return errorResponse(res, validationError, 400);
            }
        }

        let converted;
        try {
            converted = await Promise.all(files.map((file) => convertImageForStorage(file, resolveImageExtension(file))));
        } catch (conversionError) {
            console.error("HEIC conversion error:", conversionError);
            return errorResponse(res, "Could not process one of these images - the file may be corrupted", 400);
        }

        const evidence = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const { data, mimetype, extension } = converted[i];
            const storageKey = `purchases/payment-evidence/${Date.now()}-${crypto
                .randomBytes(6)
                .toString("hex")}.${extension}`;

            const { url, key } = await putObject(data, storageKey, mimetype);
            evidence.push({ url, key, name: file.name || "" });
        }

        return successResponse(
            res,
            `${evidence.length} evidence file${evidence.length === 1 ? "" : "s"} uploaded successfully`,
            { evidence }
        );

    } catch (error) {
        console.error("Payment Evidence Upload Error:", error);
        return errorResponse(res, "Payment evidence upload failed", 500);
    }
};
