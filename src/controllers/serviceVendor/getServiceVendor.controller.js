// controllers/serviceVendor/getServiceVendor.controller.js
import ServiceVendor from "../../models/ServiceVendor.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const getServiceVendorController = async (req, res) => {
  try {
    const { id } = req.params;
    const vendor = await ServiceVendor.findOne({ _id: id, isDeleted: false })
      .populate("createdBy", "name email role")
      .populate("updatedBy", "name email role")
      .lean();
    if (!vendor) {
      return errorResponse(res, "Service vendor not found", 404);
    }
    return successResponse(res, "Service vendor retrieved successfully", vendor);
  } catch (error) {
    console.error("Get Service Vendor Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve service vendor", 500);
  }
};
