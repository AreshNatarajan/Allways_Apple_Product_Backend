import crypto from "crypto";
import mongoose from "mongoose";
import User from "../../models/User.js";
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
// user id + timestamp + random bytes + an extension derived from the
// validated mimetype - the client's original filename is never used,
// which rules out path traversal / filename-based attacks entirely.
export const uploadProfileImageController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid user ID", 400);
        }

        const file = req.files?.image;

        const validationError = validateImageFile(file);
        if (validationError) {
            return errorResponse(res, validationError, 400);
        }

        const targetUser = await User.findOne({
            _id: id,
            isDeleted: false,
        });

        if (!targetUser) {
            return errorResponse(res, "User not found", 404);
        }

        const extension = MIME_TO_EXTENSION[file.mimetype] || "jpg";
        const storageKey = `users/profile/${id}-${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.${extension}`;

        const { url, key } = await putObject(
            file.data,
            storageKey,
            file.mimetype
        );

        const previousKey = targetUser.profilePhotoKey;

        targetUser.profilePhoto = url;
        targetUser.profilePhotoKey = key;
        targetUser.updatedBy = req.user._id;
        await targetUser.save();

        if (previousKey) {
            try {
                await deleteObject(previousKey);
            } catch (cleanupError) {
                console.error(
                    "Old profile image cleanup failed:",
                    cleanupError
                );
            }
        }

        return successResponse(
            res,
            "Profile image updated successfully",
            {
                profilePhoto: targetUser.profilePhoto,
            },
            200
        );

    } catch (error) {
        console.error("Upload Profile Image Error:", error);
        return errorResponse(
            res,
            "Server error while uploading profile image",
            500
        );
    }
};
