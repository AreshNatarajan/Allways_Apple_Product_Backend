// controllers/vendor/createVendor.controller.js
import Vendor from "../../models/Vendor.modal.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\d{7,15}$/;
const GST_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
const PAN_REGEX = /^[A-Z]{5}\d{4}[A-Z]$/;

// Vendor is a GLOBAL master - never accepts/derives a branchId, and the
// same vendor is shared across every branch. Do not reintroduce
// branch-scoping here.
export const createVendorController = async (req, res) => {
    try {
        const {
            name,
            companyName,
            contactPerson,
            phone,
            alternatePhone,
            email,
            address,
            city,
            state,
            country,
            pincode,
            vendorCode,
            gstNumber,
            panNumber,
            notes,
        } = req.body;

        // Validate name
        if (!name?.trim()) {
            return errorResponse(res, "Vendor name is required", 400);
        }

        // Validate optional fields' formats, only when provided
        if (email?.trim() && !EMAIL_REGEX.test(email.trim())) {
            return errorResponse(res, "Invalid email format", 400);
        }

        if (phone?.trim() && !PHONE_REGEX.test(phone.trim())) {
            return errorResponse(res, "Invalid phone number", 400);
        }

        if (alternatePhone?.trim() && !PHONE_REGEX.test(alternatePhone.trim())) {
            return errorResponse(res, "Invalid alternate phone number", 400);
        }

        if (gstNumber?.trim() && !GST_REGEX.test(gstNumber.trim().toUpperCase())) {
            return errorResponse(res, "Invalid GST number format", 400);
        }

        if (panNumber?.trim() && !PAN_REGEX.test(panNumber.trim().toUpperCase())) {
            return errorResponse(res, "Invalid PAN number format", 400);
        }

        // Check duplicate vendor name (global, case-insensitive)
        const existingVendor = await Vendor.findOne({
            name: { $regex: new RegExp(`^${name.trim()}$`, "i") },
            isDeleted: false,
        });

        if (existingVendor) {
            return errorResponse(res, `Vendor "${name}" already exists`, 409);
        }

        // Check duplicate GST (global)
        if (gstNumber?.trim()) {
            const existingGST = await Vendor.findOne({
                gstNumber: gstNumber.trim().toUpperCase(),
                isDeleted: false,
            });
            if (existingGST) {
                return errorResponse(res, `GST number "${gstNumber}" already exists`, 409);
            }
        }

        // Check duplicate email (global, only when provided)
        if (email?.trim()) {
            const existingEmail = await Vendor.findOne({
                email: email.trim().toLowerCase(),
                isDeleted: false,
            });
            if (existingEmail) {
                return errorResponse(res, `Email "${email}" already exists`, 409);
            }
        }

        // Check duplicate vendor code (global, only when provided)
        if (vendorCode?.trim()) {
            const existingCode = await Vendor.findOne({
                vendorCode: vendorCode.trim().toUpperCase(),
                isDeleted: false,
            });
            if (existingCode) {
                return errorResponse(res, `Vendor code "${vendorCode}" already exists`, 409);
            }
        }

        // Create vendor (no branchId - global master)
        const newVendor = await Vendor.create({
            name: name.trim(),
            companyName: companyName?.trim() || "",
            contactPerson: contactPerson?.trim() || "",
            phone: phone?.trim() || "",
            alternatePhone: alternatePhone?.trim() || "",
            email: email?.trim().toLowerCase() || "",
            address: address?.trim() || "",
            city: city?.trim() || "",
            state: state?.trim() || "",
            country: country?.trim() || "",
            pincode: pincode?.trim() || "",
            vendorCode: vendorCode?.trim() ? vendorCode.trim().toUpperCase() : undefined,
            gstNumber: gstNumber?.trim().toUpperCase() || "",
            panNumber: panNumber?.trim().toUpperCase() || "",
            notes: notes?.trim() || "",
            createdBy: req.user._id,
            createdByRole: req.user.role,
        });

        const populatedVendor = await Vendor.findById(newVendor._id)
            .populate("createdBy", "name email role")
            .lean();

        return successResponse(
            res,
            "Vendor created successfully",
            populatedVendor,
            201
        );
    } catch (error) {
        console.error("Create Vendor Error:", error);

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
