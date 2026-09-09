// controllers/serviceVendor/deactivateServiceVendor.controller.js
import ServiceVendor from "../../models/ServiceVendor.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Soft toggle only - no hard delete, matching this project's universal
// soft-delete convention (see CLAUDE.md). Toggles isActive both ways
// (deactivate/reactivate) via the same endpoint, controlled by the
// request body, rather than two separate routes.
export const deactivateServiceVendorController = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return errorResponse(res, "isActive must be a boolean value", 400);
    }

    const vendor = await ServiceVendor.findOne({ _id: id, isDeleted: false });
    if (!vendor) {
      return errorResponse(res, "Service vendor not found", 404);
    }

    vendor.isActive = isActive;
    vendor.updatedBy = req.user._id;
    vendor.updatedByRole = req.user.role;
    await vendor.save();

    return successResponse(res, `Service vendor ${isActive ? "activated" : "deactivated"} successfully`, {
      _id: vendor._id,
      isActive: vendor.isActive,
    });
  } catch (error) {
    console.error("Deactivate Service Vendor Error:", error);
    return errorResponse(res, error.message || "Failed to update service vendor status", 500);
  }
};
