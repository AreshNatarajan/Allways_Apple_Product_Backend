import Customer from "../../models/Customer.modal.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

import { getCustomerBranchFilter } from "../../services/customerBranchScope.js";

export const getAllCustomersController = async (req, res) => {
  try {
    console.log("Get Customer Dropdown Request");

    const { branchId } = req.query;

    // ✅ Build filter
    const filter = {
      isDeleted: false,
      isActive: true,
      ...getCustomerBranchFilter(req.user, branchId),
    };

    const customers = await Customer.find(
      filter,
      {
        name: 1,
        mobile: 1,
      }
    )
      .sort({ name: 1 })
      .lean();

    return successResponse(
      res,
      "Customers retrieved successfully",
      customers
    );

  } catch (error) {
    console.error("Get Customer Dropdown Error:", error);

    return errorResponse(
      res,
      error.message || "Failed to retrieve customers",
      500
    );
  }
}

