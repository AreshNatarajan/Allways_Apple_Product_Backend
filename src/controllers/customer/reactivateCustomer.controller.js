import mongoose from "mongoose";
import Customer from "../../models/Customer.modal.js";
import { getCustomerBranchFilter } from "../../services/customerBranchScope.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

// Reverses deleteCustomerController. Mirrors Vendor's reactivate
// pattern, plus branch isolation (BRANCH_ADMIN/STAFF can only
// reactivate a customer belonging to their own branch).
export const reactivateCustomerController = async (req, res) => {
  try {
    const { customerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return errorResponse(res, "Invalid customer ID", 400);
    }

    const loggedInUser = req.user;

    const customer = await Customer.findOne({
      _id: customerId,
      ...getCustomerBranchFilter(loggedInUser),
    });

    if (!customer) {
      return errorResponse(res, "Customer not found or access denied", 404);
    }

    if (!customer.isDeleted) {
      return errorResponse(res, "Customer is already active", 400);
    }

    customer.isDeleted = false;
    customer.isActive = true;
    customer.deletedAt = null;
    customer.updatedBy = loggedInUser._id;
    customer.updatedByRole = loggedInUser.role;

    // Same reasoning as deleteCustomerController: this is a pure
    // status-toggle save and must not be blocked by email/GST format
    // validation on legacy documents.
    await customer.save({ validateModifiedOnly: true });

    return successResponse(res, "Customer reactivated successfully", customer);
  } catch (error) {
    console.error("Reactivate Customer Error:", error);

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || { field: 1 })[0];
      return errorResponse(
        res,
        `Cannot reactivate: ${field} is already in use by another active customer in this branch.`,
        409
      );
    }

    return errorResponse(res, "Internal server error", 500);
  }
};
