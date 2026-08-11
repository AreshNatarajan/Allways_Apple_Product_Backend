import mongoose from "mongoose";
import Vendor from "../../models/Vendor.modal.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

// Soft-delete (deactivate) only - never a hard delete. Existing Purchase
// records reference a vendor by _id only, so they keep working
// unaffected once the vendor is deactivated; this controller never
// touches any other collection.
export const deleteVendorController = async (req, res) => {
  try {
    const { vendorId } = req.params;

    if (!vendorId) {
      return errorResponse(res, "Vendor ID is required", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(vendorId)) {
      return errorResponse(res, "Invalid vendor ID", 400);
    }

    const vendor = await Vendor.findOne({
      _id: vendorId,
      isDeleted: false,
    });

    if (!vendor) {
      return errorResponse(res, "Vendor not found", 404);
    }

    vendor.isDeleted = true;
    vendor.isActive = false;
    vendor.deletedAt = new Date();

    // Audit Fields
    vendor.updatedBy = req.user._id;
    vendor.updatedByRole = req.user.role;

    // Only revalidate the fields actually touched above - this
    // deactivate-only save must not be blocked by email/GST/PAN format
    // validation on legacy documents that predate stricter validation
    // rules and were never being edited here.
    await vendor.save({ validateModifiedOnly: true });

    return successResponse(res, "Vendor deactivated successfully", vendor);
  } catch (error) {
    console.error("Delete Vendor Error:", error);
    return errorResponse(res, "Failed to deactivate vendor", 500);
  }
};
