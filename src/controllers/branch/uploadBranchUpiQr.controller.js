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

// SUPER_ADMIN only. Same upload pattern as uploadBranchLogoController -
// express-fileupload (not multer), server-generated storage key, old
// S3 object cleaned up after the new one is saved.
export const uploadBranchUpiQrController = async (req, res) => {
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
        const storageKey = `branches/upi-qr/${id}-${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.${extension}`;

        const { url, key } = await putObject(
            file.data,
            storageKey,
            file.mimetype
        );

        const previousKey = branch.upiQrImageKey;

        branch.upiQrImage = url;
        branch.upiQrImageKey = key;
        branch.updatedBy = req.user._id;
        await branch.save();

        if (previousKey) {
            try {
                await deleteObject(previousKey);
            } catch (cleanupError) {
                console.error(
                    "Old branch UPI QR cleanup failed:",
                    cleanupError
                );
            }
        }

        return successResponse(
            res,
            "Branch UPI QR updated successfully",
            {
                upiQrImage: branch.upiQrImage,
            },
            200
        );

    } catch (error) {
        console.error("Upload Branch UPI QR Error:", error);
        return errorResponse(
            res,
            "Server error while uploading branch UPI QR",
            500
        );
    }
};
