import crypto from "crypto";
import {
    validateImageFile,
    MIME_TO_EXTENSION,
} from "../../middleware/uploadUserImage.middleware.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Gated by requirePermission('purchase.create') in the router - same
// grant as creating the purchase itself, so any role that can create a
// purchase can also stage its images (see purchase.create in
// config/permissionCatalog.js).
// Uploads image(s) for a serialized unit BEFORE that unit's
// ProductSerial document exists - a purchase is composed client-side
// row by row (Purchase Entry), and the physical units it will create
// aren't real database records until the whole purchase is submitted.
// So, same as how a purchase's signature is uploaded up front and its
// resulting URL is simply included in the later create-purchase JSON
// body, images picked in the Purchase Entry image modal are uploaded
// here immediately and their {url, key, name} are carried in the
// purchase item payload - createPurchase.controller.js then just
// attaches the already-uploaded images to the ProductSerial it creates,
// no further upload step needed there.
//
// Storage keys are always server-generated (id-less "staging" prefix,
// since there's no ProductSerial _id yet) - the client's original
// filename is never used for the key, only kept as a display label.
export const uploadProductSerialStagingImagesController = async (req, res) => {
    try {
        const rawFiles = req.files?.images;

        if (!rawFiles) {
            return errorResponse(res, "No image file(s) uploaded", 400);
        }

        const files = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

        for (const file of files) {
            const validationError = validateImageFile(file);
            if (validationError) {
                return errorResponse(res, validationError, 400);
            }
        }

        const uploaded = [];
        for (const file of files) {
            const extension = MIME_TO_EXTENSION[file.mimetype] || "jpg";
            const storageKey = `productSerials/staging/${Date.now()}-${crypto
                .randomBytes(6)
                .toString("hex")}.${extension}`;

            const { url, key } = await putObject(file.data, storageKey, file.mimetype);
            uploaded.push({ url, key, name: file.name || "" });
        }

        return successResponse(
            res,
            "Image(s) uploaded successfully",
            { images: uploaded },
            201
        );
    } catch (error) {
        console.error("Upload Product Serial Staging Image Error:", error);
        return errorResponse(res, "Server error while uploading image(s)", 500);
    }
};
