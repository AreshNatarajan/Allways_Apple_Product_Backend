// controllers/customer/getCustomerForTablePagination.js
import Customer from "../../models/Customer.modal.js";
import paginate from "../../utils/pagination.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

import {
  getCustomerBranchFilter,
} from "../../services/customerBranchScope.js";

export const getCustomerForTablePagination = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const { search, branchId, isActive, includeInactive } = req.query;

    // ✅ Build filter - branch-scoped (SUPER_ADMIN can filter by
    // branchId or see all; BRANCH_ADMIN/STAFF always forced to their
    // own branch regardless of what's in the query).
    const filter = {
      ...getCustomerBranchFilter(req.user, branchId),
    };

    // Active/Inactive filter - same convention as Vendor/Product/
    // Branch. Default (nothing specified) preserves the endpoint's
    // original active-only behavior. isDeleted is tied to isActive:
    // false / includeInactive rather than always excluded, since a
    // deactivated customer (isDeleted:true) must still be
    // discoverable/reactivatable, not just isActive:false docs.
    if (isActive === "true") {
      filter.isActive = true;
      filter.isDeleted = false;
    } else if (isActive === "false") {
      filter.isActive = false;
    } else if (includeInactive === "true") {
      // show everything, active and inactive alike
    } else {
      filter.isActive = true;
      filter.isDeleted = false;
    }

    // 🔍 SEARCH
    if (search?.trim()) {
      const trimmedSearch = search.trim();
      filter.$or = [
        { name: { $regex: trimmedSearch, $options: "i" } },
        { mobile: { $regex: trimmedSearch, $options: "i" } },
        { email: { $regex: trimmedSearch, $options: "i" } },
        { gstNumber: { $regex: trimmedSearch, $options: "i" } },
        { address: { $regex: trimmedSearch, $options: "i" } },
      ];
    }

    // ✅ Get customers with branch population
    const customers = await Customer.find(filter)
      .populate("branchId", "name code")  // ✅ Populate branch details
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // ✅ Format customers with branch name
    const formattedCustomers = customers.map(customer => ({
      ...customer,
      branchName: customer.branchId?.name || "N/A",
      branchCode: customer.branchId?.code || "N/A",
    }));

    const total = await Customer.countDocuments(filter);

    return successResponse(
      res,
      "Customers retrieved successfully",
      {
        customers: formattedCustomers,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      }
    );
  } catch (error) {
    console.error("Get Customers Error:", error);
    return errorResponse(
      res,
      error.message || "Failed to retrieve customers",
      500
    );
  }
};
