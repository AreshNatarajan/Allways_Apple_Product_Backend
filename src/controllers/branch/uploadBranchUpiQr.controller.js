import crypto from "crypto";
import mongoose from "mongoose";
import Branch from "../../models/Branch.modal.js";
import {
    validateImageFile,
    resolveImageExtension,
} from "../../middleware/uploadUserImage.middleware.js";
import { convertImageForStorage } from "../../services/image/convertImageForStorage.js";
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

        let converted;
        try {
            // skipCompression: a payment QR code must stay byte-exact
            // scannable - resizing/recompressing (even losslessly for
            // PNG) is a real functional risk here, not just a quality
            // tradeoff, so this only ever gets the HEIC-conversion
            // pass-through that every image upload already needed.
            converted = await convertImageForStorage(file, resolveImageExtension(file), { skipCompression: true });
        } catch (conversionError) {
            console.error("HEIC conversion error:", conversionError);
            return errorResponse(res, "Could not process this image - the file may be corrupted", 400);
        }

        const storageKey = `branches/upi-qr/${id}-${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.${converted.extension}`;

        const { url, key } = await putObject(
            converted.data,
            storageKey,
            converted.mimetype
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
