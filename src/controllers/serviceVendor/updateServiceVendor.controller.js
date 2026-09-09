// controllers/serviceVendor/updateServiceVendor.controller.js
import ServiceVendor from "../../models/ServiceVendor.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\d{7,15}$/;

export const updateServiceVendorController = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, address, notes, isActive } = req.body;

    const vendor = await ServiceVendor.findOne({ _id: id, isDeleted: false });
    if (!vendor) {
      return errorResponse(res, "Service vendor not found", 404);
    }

    if (name !== undefined) {
      if (!name.trim()) return errorResponse(res, "Service vendor name is required", 400);
      const dup = await ServiceVendor.findOne({
        _id: { $ne: id },
        name: { $regex: new RegExp(`^${name.trim()}$`, "i") },
        isDeleted: false,
      });
      if (dup) return errorResponse(res, `Service vendor "${name}" already exists`, 409);
      vendor.name = name.trim();
    }
    if (phone !== undefined) {
      if (phone.trim() && !PHONE_REGEX.test(phone.trim())) {
        return errorResponse(res, "Invalid phone number", 400);
      }
      vendor.phone = phone.trim();
    }
    if (email !== undefined) {
      if (email.trim() && !EMAIL_REGEX.test(email.trim())) {
        return errorResponse(res, "Invalid email format", 400);
      }
      if (email.trim()) {
        const dupEmail = await ServiceVendor.findOne({
          _id: { $ne: id },
          email: email.trim().toLowerCase(),
          isDeleted: false,
        });
        if (dupEmail) return errorResponse(res, `A service vendor with email "${email}" already exists`, 409);
      }
      vendor.email = email.trim().toLowerCase();
    }
    if (address !== undefined) vendor.address = address.trim();
    if (notes !== undefined) vendor.notes = notes.trim();
    if (isActive !== undefined) {
      if (typeof isActive !== "boolean") return errorResponse(res, "isActive must be a boolean value", 400);
      vendor.isActive = isActive;
    }

    vendor.updatedBy = req.user._id;
    vendor.updatedByRole = req.user.role;
    await vendor.save();

    const populated = await ServiceVendor.findById(vendor._id)
      .populate("createdBy", "name email role")
      .populate("updatedBy", "name email role")
      .lean();

    return successResponse(res, "Service vendor updated successfully", populated);
  } catch (error) {
    console.error("Update Service Vendor Error:", error);
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || { field: 1 })[0];
      return errorResponse(res, `${field} already exists`, 409);
    }
    return errorResponse(res, error.message || "Internal server error", 500);
  }
};
