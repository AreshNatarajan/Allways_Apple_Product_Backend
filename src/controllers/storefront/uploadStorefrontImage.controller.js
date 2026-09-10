import crypto from "crypto";
import { validateImageFile, resolveImageExtension } from "../../middleware/uploadUserImage.middleware.js";
import { convertImageForStorage } from "../../services/image/convertImageForStorage.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// One image per call (matching this app's existing single-file upload
// endpoints - branch logo, profile image, payment evidence) - the
// storefront admin page calls this once per photo and appends the
// returned {url,key} to the listing's own images[] array client-side,
// same pattern VendorInvoiceUpload.jsx already uses for a single PDF.
export const uploadStorefrontImageController = async (req, res) => {
    try {
        const file = req.files?.image;

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

        const storageKey = `storefront/products/${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.${converted.extension}`;

        const { url, key } = await putObject(converted.data, storageKey, converted.mimetype);

        return successResponse(res, "Image uploaded successfully", { url, key });
    } catch (error) {
        console.error("Storefront Image Upload Error:", error);
        return errorResponse(res, "Image upload failed", 500);
    }
};
