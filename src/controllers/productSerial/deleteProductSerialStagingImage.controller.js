import { deleteObject } from "../fileUpload/Products/deleteObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// SUPER_ADMIN / BRANCH_ADMIN only. Removes a staged image (uploaded via
// uploadProductSerialStagingImagesController) while a purchase is still
// being composed client-side, before any ProductSerial document exists
// to own it - so there's no DB record to update here, just the S3
// object itself. Identified by its S3 key (the one value guaranteed
// unique per image), matching removeProductImageController's
// key-based-not-index-based convention.
export const deleteProductSerialStagingImageController = async (req, res) => {
    try {
        const { key } = req.body;

        if (!key) {
            return errorResponse(res, "Image key is required", 400);
        }

        if (!key.startsWith("productSerials/staging/")) {
            return errorResponse(res, "Invalid staging image key", 400);
        }

        await deleteObject(key);

        return successResponse(res, "Staged image removed successfully", { key });
    } catch (error) {
        console.error("Delete Product Serial Staging Image Error:", error);
        return errorResponse(res, "Server error while removing staged image", 500);
    }
};
