import mongoose from "mongoose";
import Vendor from "../../models/Vendor.modal.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

// Reverses deleteVendorController. Mirrors Product's reactivate pattern.
export const reactivateVendorController = async (req, res) => {
  try {
    const { vendorId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(vendorId)) {
      return errorResponse(res, "Invalid vendor ID", 400);
    }

    const vendor = await Vendor.findById(vendorId);

    if (!vendor) {
      return errorResponse(res, "Vendor not found", 404);
    }

    if (!vendor.isDeleted) {
      return errorResponse(res, "Vendor is already active", 400);
    }

    vendor.isDeleted = false;
    vendor.isActive = true;
    vendor.deletedAt = null;
    vendor.updatedBy = req.user._id;
    vendor.updatedByRole = req.user.role;

    // Same reasoning as deleteVendorController: this is a pure
    // status-toggle save and must not be blocked by email/GST/PAN
    // format validation on legacy documents.
    await vendor.save({ validateModifiedOnly: true });

    return successResponse(res, "Vendor reactivated successfully", vendor);
  } catch (error) {
    console.error("Reactivate Vendor Error:", error);

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || { field: 1 })[0];
      return errorResponse(
        res,
        `Cannot reactivate: ${field} is already in use by another active vendor.`,
        409
      );
    }

    return errorResponse(res, "Internal server error", 500);
  }
};
