import mongoose from "mongoose";
import Vendor from "../../models/Vendor.modal.js";
import { deleteObject } from "../fileUpload/Products/deleteObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Full CRUD's "Delete" - removes one attachment by its S3 key. The key
// must actually belong to this vendor's own attachments array (never
// just any key), so one vendor's delete request can never touch another
// vendor's - or any unrelated - S3 object. The database removal always
// happens even if the S3 delete itself fails (logged, not fatal) - "gone
// from the vendor's records" is what a user means by delete, and an S3
// cleanup lag (e.g. a temporarily revoked delete permission on the
// bucket credentials) shouldn't leave a dead attachment stuck in the
// vendor's list forever.
export const deleteVendorAttachmentController = async (req, res) => {
    try {
        const { vendorId } = req.params;
        const { key } = req.body;

        if (!mongoose.Types.ObjectId.isValid(vendorId)) {
            return errorResponse(res, "Invalid vendor ID", 400);
        }
        if (!key) {
            return errorResponse(res, "Attachment key is required", 400);
        }

        const vendor = await Vendor.findOne({ _id: vendorId, isDeleted: false });
        if (!vendor) {
            return errorResponse(res, "Vendor not found", 404);
        }

        const exists = vendor.attachments.some((a) => a.key === key);
        if (!exists) {
            return errorResponse(res, "Attachment not found on this vendor", 404);
        }

        try {
            await deleteObject(key);
        } catch (cleanupError) {
            console.error("Vendor attachment S3 cleanup failed (removed from vendor record regardless):", cleanupError);
        }

        vendor.attachments = vendor.attachments.filter((a) => a.key !== key);
        vendor.updatedBy = req.user._id;
        vendor.updatedByRole = req.user.role;
        await vendor.save();

        return successResponse(res, "Attachment removed successfully", { attachments: vendor.attachments });
    } catch (error) {
        console.error("Delete Vendor Attachment Error:", error);
        return errorResponse(res, "Server error while removing attachment", 500);
    }
};
