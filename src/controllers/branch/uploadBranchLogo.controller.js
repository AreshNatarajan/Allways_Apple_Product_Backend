import crypto from "crypto";
import mongoose from "mongoose";
import Branch from "../../models/Branch.modal.js";
import {
    validateImageFile,
    MIME_TO_EXTENSION,
} from "../../middleware/uploadUserImage.middleware.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { deleteObject } from "../fileUpload/Products/deleteObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// SUPER_ADMIN only. Uses the global express-fileupload middleware
// (already mounted app-wide in server.js) rather than multer - a second
// multipart parser on the same request always fails with "Unexpected
// end of form" since express-fileupload has already consumed the
// stream. Storage key is always generated server-side from the target
// branch id + timestamp + random bytes + an extension derived from the
// validated mimetype - the client's original filename is never used.
export const uploadBranchLogoController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid branch ID", 400);
        }

        const file = req.files?.image;

        const validationError = validateImageFile(file);
        if (validationError) {
            return errorResponse(res, validationError, 400);
        }

        const branch = await Branch.findOne({
            _id: id,
            isDeleted: false,
        });

        if (!branch) {
            return errorResponse(res, "Branch not found", 404);
        }

        const extension = MIME_TO_EXTENSION[file.mimetype] || "jpg";
        const storageKey = `branches/logo/${id}-${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.${extension}`;

        const { url, key } = await putObject(
            file.data,
            storageKey,
            file.mimetype
        );

        const previousKey = branch.logoKey;

        branch.logo = url;
        branch.logoKey = key;
        branch.updatedBy = req.user._id;
        await branch.save();

        if (previousKey) {
            try {
                await deleteObject(previousKey);
            } catch (cleanupError) {
                console.error(
                    "Old branch logo cleanup failed:",
                    cleanupError
                );
            }
        }

        return successResponse(
            res,
            "Branch logo updated successfully",
            {
                logo: branch.logo,
            },
            200
        );

    } catch (error) {
        console.error("Upload Branch Logo Error:", error);
        return errorResponse(
            res,
            "Server error while uploading branch logo",
            500
        );
    }
};
