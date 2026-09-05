import crypto from "crypto";
import { validateImageFile, MIME_TO_EXTENSION } from "../../middleware/uploadUserImage.middleware.js";
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

        const extension = MIME_TO_EXTENSION[file.mimetype];
        const storageKey = `storefront/products/${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.${extension}`;

        const { url, key } = await putObject(file.data, storageKey, file.mimetype);

        return successResponse(res, "Image uploaded successfully", { url, key });
    } catch (error) {
        console.error("Storefront Image Upload Error:", error);
        return errorResponse(res, "Image upload failed", 500);
    }
};
