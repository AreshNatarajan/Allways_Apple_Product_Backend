import mongoose from "mongoose";
import Customer from "../../models/Customer.modal.js";
import { getCustomerBranchFilter } from "../../services/customerBranchScope.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

// Soft-delete (deactivate) only - never a hard delete. Existing Sale
// records reference a customer by _id only, so they keep working
// unaffected once the customer is deactivated; this controller never
// touches any other collection.
export const deleteCustomerController = async (req, res) => {
  try {

    const { customerId } = req.params;

    if (!customerId) {
      return errorResponse(res, "Customer ID is required", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return errorResponse(res, "Invalid customer ID", 400);
    }

    const loggedInUser = req.user;

    // Branch isolation: BRANCH_ADMIN/STAFF can only deactivate a
    // customer that belongs to their own branch. SUPER_ADMIN is
    // unrestricted.
    const customer = await Customer.findOne({
      _id: customerId,
      isDeleted: false,
      ...getCustomerBranchFilter(loggedInUser),
    });

    if (!customer) {
      return errorResponse(res, "Customer not found or access denied", 404);
    }

    customer.isDeleted = true;
    customer.isActive = false;
    customer.deletedAt = new Date();
    customer.updatedBy = loggedInUser._id;
    customer.updatedByRole = loggedInUser.role;

    // Only revalidate the fields actually touched above - this
    // deactivate-only save must not be blocked by email/GST format
    // validation on legacy documents that predate stricter validation
    // rules and were never being edited here.
    await customer.save({ validateModifiedOnly: true });

    return successResponse(
      res,
      "Customer deleted successfully",
      customer
    );

  } catch (error) {

    console.error("Delete Customer Error:", error);

    return errorResponse(
      res,
      "Failed to delete customer",
      500
    );
  }
};
