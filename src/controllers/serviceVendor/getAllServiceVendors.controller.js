// controllers/serviceVendor/getAllServiceVendors.controller.js
import ServiceVendor from "../../models/ServiceVendor.modal.js";
import paginate from "../../utils/pagination.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const getAllServiceVendorsController = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const { search, isActive, includeInactive } = req.query;

    // Global master - no branch filter, same as Vendor's own list.
    const filter = {};

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

    if (search?.trim()) {
      const trimmedSearch = search.trim();
      filter.$or = [
        { name: { $regex: trimmedSearch, $options: "i" } },
        { phone: { $regex: trimmedSearch, $options: "i" } },
        { email: { $regex: trimmedSearch, $options: "i" } },
      ];
    }

    const [serviceVendors, total] = await Promise.all([
      ServiceVendor.find(filter)
        .populate("createdBy", "name email role")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ServiceVendor.countDocuments(filter),
    ]);

    return successResponse(res, "Service vendors retrieved successfully", {
      serviceVendors,
      pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    console.error("Get Service Vendors Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve service vendors", 500);
  }
};

// Unpaginated, active-only, for the Allocate Vendor picker on the
// Service Detail page - only real ServiceVendors are ever selectable
// there, never a Vendor (purchase supplier).
export const getServiceVendorOptionsController = async (req, res) => {
  try {
    const serviceVendors = await ServiceVendor.find({ isActive: true, isDeleted: false })
      .select("name phone email")
      .sort({ name: 1 })
      .lean();
    return successResponse(res, "Service vendor options retrieved successfully", { serviceVendors });
  } catch (error) {
    console.error("Get Service Vendor Options Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve service vendor options", 500);
  }
};
