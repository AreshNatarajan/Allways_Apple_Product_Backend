import mongoose from "mongoose";
import Customer from "../../models/Customer.modal.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";
import { getCustomerBranchFilter } from "../../services/customerBranchScope.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\d{7,15}$/;
const GST_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

// Only known, explicitly-listed fields are ever read from req.body and
// assigned individually below - _id, createdAt, createdBy, and
// isDeleted are never destructured from the request, so arbitrary
// client input can never touch them regardless of what the client
// sends. Reassigning branchId is SUPER_ADMIN-only (mirrors "never
// trust branchId from body" for BRANCH_ADMIN/STAFF elsewhere in the
// project) - those roles can only edit customers already inside their
// own branch and cannot move them out.
export const updateCustomerController = async (req, res) => {
  try {

    const { customerId } = req.params;

    if (!customerId) {
      return errorResponse(res, "Customer ID is required", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return errorResponse(res, "Invalid customer ID", 400);
    }

    const loggedInUser = req.user;

    const {
      name,
      mobile,
      alternatePhone,
      email,
      address,
      city,
      state,
      country,
      pincode,
      customerCode,
      gstNumber,
      notes,
      isActive,
      branchId,
    } = req.body;

    // Branch isolation: BRANCH_ADMIN/STAFF can only fetch/update a
    // customer that already belongs to their own branch. SUPER_ADMIN
    // is unrestricted.
    const customer = await Customer.findOne({
      _id: customerId,
      isDeleted: false,
      ...getCustomerBranchFilter(loggedInUser),
    });

    if (!customer) {
      return errorResponse(res, "Customer not found or access denied", 404);
    }

    // Reassigning branch - SUPER_ADMIN only, and the new branch must
    // exist and be active.
    let targetBranchId = customer.branchId;
    if (branchId !== undefined) {
      if (loggedInUser.role !== "SUPER_ADMIN") {
        return errorResponse(res, "Only Super Admin can reassign a customer's branch", 403);
      }

      const branchCheck = await resolveActiveBranch(branchId);
      if (branchCheck.error) {
        return errorResponse(
          res,
          branchCheck.error,
          branchCheck.error === "Branch not found" ? 404 : 400
        );
      }

      targetBranchId = branchCheck.branch._id;
    }

    // Validate optional fields' formats, only when provided
    if (email !== undefined && email?.trim() && !EMAIL_REGEX.test(email.trim())) {
      return errorResponse(res, "Invalid email format", 400);
    }

    if (mobile !== undefined && mobile?.trim() && !PHONE_REGEX.test(mobile.trim())) {
      return errorResponse(res, "Invalid phone number", 400);
    }

    if (
      alternatePhone !== undefined &&
      alternatePhone?.trim() &&
      !PHONE_REGEX.test(alternatePhone.trim())
    ) {
      return errorResponse(res, "Invalid alternate phone number", 400);
    }

    if (
      gstNumber !== undefined &&
      gstNumber?.trim() &&
      !GST_REGEX.test(gstNumber.trim().toUpperCase())
    ) {
      return errorResponse(res, "Invalid GST number format", 400);
    }

    // Duplicate checks - scoped to the (possibly new) target branch,
    // excluding this customer itself.
    if (mobile?.trim() && mobile.trim() !== customer.mobile) {
      const existingMobile = await Customer.findOne({
        _id: { $ne: customerId },
        branchId: targetBranchId,
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

    if (email?.trim() && email.trim().toLowerCase() !== customer.email) {
      const existingEmail = await Customer.findOne({
        _id: { $ne: customerId },
        branchId: targetBranchId,
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

    if (gstNumber?.trim() && gstNumber.trim().toUpperCase() !== customer.gstNumber) {
      const existingGST = await Customer.findOne({
        _id: { $ne: customerId },
        branchId: targetBranchId,
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

    if (customerCode?.trim() && customerCode.trim().toUpperCase() !== customer.customerCode) {
      const existingCode = await Customer.findOne({
        _id: { $ne: customerId },
        branchId: targetBranchId,
        customerCode: customerCode.trim().toUpperCase(),
        isDeleted: false,
      });
      if (existingCode) {
        return errorResponse(
          res,
          `Customer code "${customerCode}" already exists in this branch`,
          409
        );
      }
    }

    if (branchId !== undefined) customer.branchId = targetBranchId;
    if (name !== undefined) customer.name = name.trim();
    if (mobile !== undefined) customer.mobile = mobile.trim();
    if (alternatePhone !== undefined) customer.alternatePhone = alternatePhone.trim();
    if (email !== undefined) customer.email = email.trim().toLowerCase();
    if (address !== undefined) customer.address = address.trim();
    if (city !== undefined) customer.city = city.trim();
    if (state !== undefined) customer.state = state.trim();
    if (country !== undefined) customer.country = country.trim();
    if (pincode !== undefined) customer.pincode = pincode.trim();
    if (customerCode !== undefined) {
      customer.customerCode = customerCode.trim() ? customerCode.trim().toUpperCase() : undefined;
    }
    if (gstNumber !== undefined) customer.gstNumber = gstNumber.trim().toUpperCase();
    if (notes !== undefined) customer.notes = notes.trim();
    if (typeof isActive === "boolean") customer.isActive = isActive;

    customer.updatedBy = loggedInUser._id;
    customer.updatedByRole = loggedInUser.role;

    await customer.save();

    const populatedCustomer = await Customer.findById(customer._id)
      .populate("branchId", "name code")
      .populate("updatedBy", "name email role")
      .lean();

    return successResponse(
      res,
      "Customer updated successfully",
      populatedCustomer
    );

  } catch (error) {

    console.error("Update Customer Error:", error);

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
      "Failed to update customer",
      500
    );
  }
};
