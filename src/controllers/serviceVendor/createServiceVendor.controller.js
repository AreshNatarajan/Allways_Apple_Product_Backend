// controllers/serviceVendor/createServiceVendor.controller.js
import ServiceVendor from "../../models/ServiceVendor.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\d{7,15}$/;

// ServiceVendor is a GLOBAL master (no branchId), same reasoning as
// Vendor - never accepts/derives a branchId. Deliberately separate
// model/collection from Vendor (the purchase-supplier concept) - see
// ServiceVendor.modal.js.
export const createServiceVendorController = async (req, res) => {
  try {
    const { name, phone, email, address, notes } = req.body;

    if (!name?.trim()) {
      return errorResponse(res, "Service vendor name is required", 400);
    }
    if (phone?.trim() && !PHONE_REGEX.test(phone.trim())) {
      return errorResponse(res, "Invalid phone number", 400);
    }
    if (email?.trim() && !EMAIL_REGEX.test(email.trim())) {
      return errorResponse(res, "Invalid email format", 400);
    }

    const existing = await ServiceVendor.findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, "i") },
      isDeleted: false,
    });
    if (existing) {
      return errorResponse(res, `Service vendor "${name}" already exists`, 409);
    }

    if (email?.trim()) {
      const existingEmail = await ServiceVendor.findOne({
        email: email.trim().toLowerCase(),
        isDeleted: false,
      });
      if (existingEmail) {
        return errorResponse(res, `A service vendor with email "${email}" already exists`, 409);
      }
    }

    const newServiceVendor = await ServiceVendor.create({
      name: name.trim(),
      phone: phone?.trim() || "",
      email: email?.trim().toLowerCase() || "",
      address: address?.trim() || "",
      notes: notes?.trim() || "",
      createdBy: req.user._id,
      createdByRole: req.user.role,
    });

    const populated = await ServiceVendor.findById(newServiceVendor._id)
      .populate("createdBy", "name email role")
      .lean();

    return successResponse(res, "Service vendor created successfully", populated, 201);
  } catch (error) {
    console.error("Create Service Vendor Error:", error);
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return errorResponse(res, `Validation failed: ${messages.join(", ")}`, 400);
    }
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || { field: 1 })[0];
      return errorResponse(res, `${field} already exists`, 409);
    }
    return errorResponse(res, error.message || "Internal server error", 500);
  }
};
