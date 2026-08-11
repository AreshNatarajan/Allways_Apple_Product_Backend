import mongoose from "mongoose";
import Customer from "../../models/Customer.modal.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

import { getCustomerBranchFilter } from "../../services/customerBranchScope.js";

// Get a single customer by ID. Branch isolation: BRANCH_ADMIN/STAFF can
// only fetch a customer belonging to their own branch. SUPER_ADMIN is
// unrestricted.
export const getCustomerController = async (
  req,
  res
) => {
  try {

    const { customerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return errorResponse(res, "Invalid customer ID", 400);
    }

    const customer =
      await Customer.findOne({
        _id: customerId,
        isDeleted: false,
        ...getCustomerBranchFilter(req.user),
      })
        .populate("branchId", "name code")
        .populate("createdBy", "name email role")
        .populate("updatedBy", "name email role")
        .lean();

    if (!customer) {

      return errorResponse(
        res,
        "Customer not found",
        404
      );

    }

    return successResponse(
      res,
      "Customer retrieved successfully",
      customer
    );

  } catch (error) {

    console.error(error);

    return errorResponse(
      res,
      "Error retrieving customer",
      500
    );
  }
};
