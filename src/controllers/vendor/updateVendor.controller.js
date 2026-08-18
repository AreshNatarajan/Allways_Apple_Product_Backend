import mongoose from "mongoose";
import Vendor from "../../models/Vendor.modal.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\d{7,15}$/;
const GST_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

// Vendor is a GLOBAL master. Only known, explicitly-listed fields are
// ever read from req.body and assigned individually below - branchId,
// createdBy, createdAt, and isDeleted are never destructured from the
// request, so arbitrary client input can never touch them regardless
// of what the client sends.
export const updateVendorController = async (req, res) => {
  try {
    const { vendorId } = req.params;

    if (!vendorId) {
      return errorResponse(res, "Vendor ID is required", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(vendorId)) {
      return errorResponse(res, "Invalid vendor ID", 400);
    }

    const {
      name,
      companyName,
      phone,
      email,
      address,
      gstNumber,
      notes,
      isActive,
    } = req.body;

    const vendor = await Vendor.findOne({
      _id: vendorId,
      isDeleted: false,
    });

    if (!vendor) {
      return errorResponse(res, "Vendor not found", 404);
    }

    // Validate optional fields' formats, only when provided
    if (phone !== undefined && phone?.trim() && !PHONE_REGEX.test(phone.trim())) {
      return errorResponse(res, "Invalid phone number", 400);
    }

    if (email !== undefined && email?.trim() && !EMAIL_REGEX.test(email.trim())) {
      return errorResponse(res, "Invalid email format", 400);
    }

    if (
      gstNumber !== undefined &&
      gstNumber?.trim() &&
      !GST_REGEX.test(gstNumber.trim().toUpperCase())
    ) {
      return errorResponse(res, "Invalid GST number format", 400);
    }

    // Duplicate name check
    if (name?.trim() && name.trim().toLowerCase() !== vendor.name.toLowerCase()) {
      const existingVendor = await Vendor.findOne({
        _id: { $ne: vendorId },
        name: { $regex: new RegExp(`^${name.trim()}$`, "i") },
        isDeleted: false,
      });

      if (existingVendor) {
        return errorResponse(res, `Vendor "${name}" already exists`, 409);
      }
    }

    // Duplicate GST check
    if (gstNumber?.trim() && gstNumber.trim().toUpperCase() !== vendor.gstNumber) {
      const existingGST = await Vendor.findOne({
        _id: { $ne: vendorId },
        gstNumber: gstNumber.trim().toUpperCase(),
        isDeleted: false,
      });

      if (existingGST) {
        return errorResponse(res, `GST number "${gstNumber}" already exists`, 409);
      }
    }

    // Duplicate email check
    if (email?.trim() && email.trim().toLowerCase() !== vendor.email) {
      const existingEmail = await Vendor.findOne({
        _id: { $ne: vendorId },
        email: email.trim().toLowerCase(),
        isDeleted: false,
      });

      if (existingEmail) {
        return errorResponse(res, `A vendor with email "${email}" already exists`, 409);
      }
    }

    if (name !== undefined) vendor.name = name.trim();
    if (companyName !== undefined) vendor.companyName = companyName.trim();
    if (phone !== undefined) vendor.phone = phone.trim();
    if (email !== undefined) vendor.email = email.trim().toLowerCase();
    if (address !== undefined) vendor.address = address.trim();
    if (gstNumber !== undefined) vendor.gstNumber = gstNumber.trim().toUpperCase();
    if (notes !== undefined) vendor.notes = notes.trim();
    if (typeof isActive === "boolean") vendor.isActive = isActive;

    // Audit Fields
    vendor.updatedBy = req.user._id;
    vendor.updatedByRole = req.user.role;

    await vendor.save();

    return successResponse(res, "Vendor updated successfully", vendor);
  } catch (error) {
    console.error("Update Vendor Error:", error);

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return errorResponse(res, `Validation failed: ${messages.join(", ")}`, 400);
    }

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || { field: 1 })[0];
      return errorResponse(res, `${field} already exists`, 409);
    }

    return errorResponse(res, "Failed to update vendor", 500);
  }
};
