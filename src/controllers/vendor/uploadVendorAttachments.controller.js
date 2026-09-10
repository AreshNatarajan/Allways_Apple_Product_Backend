import crypto from "crypto";
import mongoose from "mongoose";
import Vendor from "../../models/Vendor.modal.js";
import { validateDocumentFile, resolveDocumentExtension } from "../../middleware/uploadDocument.middleware.js";
import { convertImageForStorage } from "../../services/image/convertImageForStorage.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Full CRUD's "Create" - accepts one or more files under req.files.attachments
// (dynamic count, no fixed slots) and appends them straight onto the
// real, already-existing Vendor document (unlike the staging patterns
// elsewhere in this app, a vendor already has an _id by the time
// attachments are added - see VendorDetailPage.jsx). Gated by
// requirePermission('vendor.edit') in the router - same grant as
// editing any other vendor field.
export const uploadVendorAttachmentsController = async (req, res) => {
    try {
        const { vendorId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(vendorId)) {
            return errorResponse(res, "Invalid vendor ID", 400);
        }

        const vendor = await Vendor.findOne({ _id: vendorId, isDeleted: false });
        if (!vendor) {
            return errorResponse(res, "Vendor not found", 404);
        }

        const rawFiles = req.files?.attachments;
        if (!rawFiles) {
            return errorResponse(res, "No file(s) uploaded", 400);
        }
        const files = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

        for (const file of files) {
            const validationError = validateDocumentFile(file);
            if (validationError) {
                return errorResponse(res, validationError, 400);
            }
        }

        let converted;
        try {
            converted = await Promise.all(files.map((file) => convertImageForStorage(file, resolveDocumentExtension(file))));
        } catch (conversionError) {
            console.error("Vendor attachment HEIC conversion error:", conversionError);
            return errorResponse(res, "Could not process one of these images - the file may be corrupted", 400);
        }

        const newAttachments = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const { data, mimetype, extension } = converted[i];
            const storageKey = `vendors/attachments/${vendorId}/${Date.now()}-${crypto
                .randomBytes(6)
                .toString("hex")}.${extension}`;

            const { url, key } = await putObject(data, storageKey, mimetype);

            newAttachments.push({
                url,
                key,
                name: file.name || "",
                size: file.size || 0,
                uploadedBy: req.user._id,
                uploadedByName: req.user.name || "",
                uploadedAt: new Date(),
            });
        }

        vendor.attachments.push(...newAttachments);
        vendor.updatedBy = req.user._id;
        vendor.updatedByRole = req.user.role;
        await vendor.save();

        return successResponse(
            res,
            `${newAttachments.length} attachment${newAttachments.length === 1 ? "" : "s"} uploaded successfully`,
            { attachments: vendor.attachments },
            201
        );
    } catch (error) {
        console.error("Upload Vendor Attachments Error:", error);
        return errorResponse(res, "Server error while uploading attachment(s)", 500);
    }
};
