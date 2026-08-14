import crypto from "crypto";
import {
    validateImageFile,
    MIME_TO_EXTENSION,
} from "../../middleware/uploadUserImage.middleware.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Uploads a branch purchase's mandatory accountability selfie BEFORE the
// Purchase document exists - same staging pattern as
// uploadProductSerialStagingImage.controller.js (server-generated,
// id-less "staging" key, since there's no Purchase _id yet). The client
// carries the returned {url,key} in createPurchaseController's payload,
// which then just attaches it to the Purchase it creates - no separate
// finalize/move step. Any authenticated role may call this (the actual
// "branch purchases only" rule is enforced in createPurchase.controller.js,
// not here - a SUPER_ADMIN optionally attaching a selfie is harmless).
export const uploadPurchaseSelfieController = async (req, res) => {
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

        const extension = MIME_TO_EXTENSION[file.mimetype] || "jpg";
        const storageKey = `purchases/selfies/staging/${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.${extension}`;

        const { url, key } = await putObject(file.data, storageKey, file.mimetype);

        return successResponse(
            res,
            "Selfie uploaded successfully",
            { url, key },
            201
        );
    } catch (error) {
        console.error("Upload Purchase Selfie Error:", error);
        return errorResponse(res, "Server error while uploading selfie", 500);
    }
};
