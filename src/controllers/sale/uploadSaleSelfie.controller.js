import crypto from "crypto";
import {
    validateImageFile,
    resolveImageExtension,
} from "../../middleware/uploadUserImage.middleware.js";
import { convertImageForStorage } from "../../services/image/convertImageForStorage.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Uploads a non-SUPER_ADMIN sale's mandatory accountability selfie
// BEFORE the Sale document exists - same staging pattern as
// uploadPurchaseSelfie.controller.js (server-generated, id-less
// "staging" key, since there's no Sale _id yet). The client carries the
// returned {url,key} in createSaleController's payload, which then just
// attaches it to the Sale it creates - no separate finalize/move step.
export const uploadSaleSelfieController = async (req, res) => {
    try {
        const file = req.files?.selfie;

        if (!file) {
            return errorResponse(res, "No selfie file uploaded", 400);
        }
        if (Array.isArray(file)) {
            return errorResponse(res, "Only one selfie can be uploaded at a time", 400);
        }

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

        const storageKey = `sales/selfies/staging/${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.${converted.extension}`;

        const { url, key } = await putObject(converted.data, storageKey, converted.mimetype);

        return successResponse(
            res,
            "Selfie uploaded successfully",
            { url, key },
            201
        );
    } catch (error) {
        console.error("Upload Sale Selfie Error:", error);
        return errorResponse(res, "Server error while uploading selfie", 500);
    }
};
