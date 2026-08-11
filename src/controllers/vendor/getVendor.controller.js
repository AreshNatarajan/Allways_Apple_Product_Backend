import mongoose from "mongoose";
import Vendor from "../../models/Vendor.modal.js";
import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

// Vendor is global - no branchId anywhere on this schema, so no branch
// filter is applied here. (A prior version of this controller queried
// with `branchId: req.params.branchId`, but no route ever supplied a
// :branchId param and Vendor has no such field - that filter key was
// always undefined and effectively a no-op, left over from an early
// branch-scoped design that was already abandoned in the schema.)
export const getVendorController = async (req, res) => {
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
    }).populate("createdBy", "name email role");

    if (!vendor) {
      return errorResponse(res, "Vendor not found", 404);
    }

    return successResponse(res, "Vendor retrieved successfully", vendor);
  } catch (error) {
    console.error("Get Vendor Error:", error);
    return errorResponse(res, "Error retrieving vendor", 500);
  }
};
