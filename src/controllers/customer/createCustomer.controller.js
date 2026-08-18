import Customer from "../../models/Customer.modal.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\d{7,15}$/;
const GST_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

// Customer is BRANCH-SCOPED (unlike Vendor, which is a global master).
// SUPER_ADMIN may create a customer for any active branch by supplying
// branchId in the body; BRANCH_ADMIN/STAFF always get their own
// req.user.branchId - branchId from the body is never trusted/used for
// those roles.
export const createCustomerController = async (req, res) => {
    try {
        const {
            name,
            mobile,
            email,
            address,
            gstNumber,
            notes,
        } = req.body;

        const loggedInUser = req.user;

        const branchId =
            loggedInUser.role === "SUPER_ADMIN"
                ? req.body.branchId
                : loggedInUser.branchId;

        const branchCheck = await resolveActiveBranch(branchId);
        if (branchCheck.error) {
            return errorResponse(
                res,
                branchCheck.error,
                branchCheck.error === "Branch not found" ? 404 : 400
            );
        }

        if (!name?.trim()) {
            return errorResponse(res, "Customer name is required", 400);
        }

        // Validate optional fields' formats, only when provided
        if (email?.trim() && !EMAIL_REGEX.test(email.trim())) {
            return errorResponse(res, "Invalid email format", 400);
        }

        if (mobile?.trim() && !PHONE_REGEX.test(mobile.trim())) {
            return errorResponse(res, "Invalid phone number", 400);
        }

        // GST is OPTIONAL - only validated/checked for duplicates when provided
        if (gstNumber?.trim() && !GST_REGEX.test(gstNumber.trim().toUpperCase())) {
            return errorResponse(res, "Invalid GST number format", 400);
        }

        // Duplicate checks - scoped to this branch (Customer is branch-scoped,
        // so the same phone/email/GST/code may legitimately exist at a
        // different branch).
        if (mobile?.trim()) {
            const existingMobile = await Customer.findOne({
                branchId: branchCheck.branch._id,
                mobile: mobile.trim(),
                isDeleted: false,
            });
            if (existingMobile) {
                return errorResponse(
                    res,
                    `A customer with phone "${mobile}" already exists in this branch`,
                    409
                );
            }
        }

        if (email?.trim()) {
            const existingEmail = await Customer.findOne({
                branchId: branchCheck.branch._id,
                email: email.trim().toLowerCase(),
                isDeleted: false,
            });
            if (existingEmail) {
                return errorResponse(
                    res,
                    `A customer with email "${email}" already exists in this branch`,
                    409
                );
            }
        }

        if (gstNumber?.trim()) {
            const existingGST = await Customer.findOne({
                branchId: branchCheck.branch._id,
                gstNumber: gstNumber.trim().toUpperCase(),
                isDeleted: false,
            });
            if (existingGST) {
                return errorResponse(
                    res,
                    `A customer with GST "${gstNumber}" already exists in this branch`,
                    409
                );
            }
        }

        const customer = await Customer.create({
            branchId: branchCheck.branch._id,
            name: name.trim(),
            mobile: mobile?.trim() || "",
            email: email?.trim().toLowerCase() || "",
            address: address?.trim() || "",
            gstNumber: gstNumber?.trim().toUpperCase() || "",
            notes: notes?.trim() || "",
            createdBy: loggedInUser._id,
            createdByRole: loggedInUser.role,
        });

        const populatedCustomer = await Customer.findById(customer._id)
            .populate("branchId", "name code")
            .populate("createdBy", "name email role")
            .lean();

        return successResponse(
            res,
            "Customer created successfully",
            populatedCustomer,
            201
        );

    } catch (error) {

        console.error("Create Customer Error:", error);

        if (error.name === "ValidationError") {
            const messages = Object.values(error.errors).map((err) => err.message);
            return errorResponse(res, `Validation failed: ${messages.join(", ")}`, 400);
        }

        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern || { field: 1 })[0];
            return errorResponse(res, `${field} already exists in this branch`, 409);
        }

        return errorResponse(
            res,
            "Error creating customer",
            500
        );
    }
};
