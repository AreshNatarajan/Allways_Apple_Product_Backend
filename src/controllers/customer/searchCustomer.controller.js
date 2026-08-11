import Customer from "../../models/Customer.modal.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

import { getCustomerBranchFilter } from "../../services/customerBranchScope.js";

export const searchCustomerController = async (req, res) => {
  try {
    const { search = "", branchId } = req.query;

    const keyword = search.trim();

    // ✅ Base query
    const query = {
      isDeleted: false,
      isActive: true,
      ...getCustomerBranchFilter(req.user, branchId),
    };

    // ✅ Search
    if (keyword.length > 0) {
      query.$or = [
        {
          name: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          mobile: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          email: {
            $regex: keyword,
            $options: "i",
          },
        },
        {
          gstNumber: {
            $regex: keyword,
            $options: "i",
          },
        },
      ];
    }

    console.log("Search :", keyword);
    console.log("Branch Filter :", getCustomerBranchFilter(req.user, branchId));
    console.log("Query :", JSON.stringify(query, null, 2));

    const customers = await Customer.find(query)
      .select("name mobile email address gstNumber")
      .sort({ name: 1 })
      .limit(20)
      .lean();

    console.log("Customers Found :", customers.length);

    return successResponse(
      res,
      "Customers retrieved successfully",
      customers
    );
  } catch (error) {
    console.error("Search Customer Error:", error);

    return errorResponse(
      res,
      error.message || "Failed to search customers",
      500
    );
  }
};

