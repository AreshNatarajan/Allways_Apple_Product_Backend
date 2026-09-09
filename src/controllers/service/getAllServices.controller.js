// controllers/service/getAllServices.controller.js
import mongoose from "mongoose";
import Service from "../../models/Service.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Paginated/filterable list, mirrors getAllTransfers.controller.js's
// shape. branch: SUPER_ADMIN optionally scopes to any one branch via
// `branchId` (matched against either origin or service side);
// everyone else is always scoped to a branch they're involved in
// (their own branch as either origin or service branch).
export const getAllServicesController = async (req, res) => {
  try {
    const user = req.user;
    const {
      page = 1, limit = 10, search = "", status = "ALL", serviceType = "ALL",
      branchId, serviceVendorId, startDate, endDate,
    } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { isDeleted: false };

    const scopeBranchId = user.role === "SUPER_ADMIN" ? branchId : user.branchId?.toString();
    if (scopeBranchId && scopeBranchId !== "ALL" && mongoose.Types.ObjectId.isValid(scopeBranchId)) {
      const branchObjectId = new mongoose.Types.ObjectId(scopeBranchId);
      filter.$or = [{ originBranchId: branchObjectId }, { serviceBranchId: branchObjectId }];
    } else if (user.role !== "SUPER_ADMIN") {
      return errorResponse(res, "Branch not assigned to user", 400);
    }

    if (status && status !== "ALL") filter.status = status;
    if (serviceType && serviceType !== "ALL") filter.serviceType = serviceType;
    if (serviceVendorId && mongoose.Types.ObjectId.isValid(serviceVendorId)) filter.serviceVendorId = serviceVendorId;

    if (startDate || endDate) {
      const range = {};
      if (startDate) range.$gte = new Date(`${startDate}T00:00:00.000Z`);
      if (endDate) range.$lte = new Date(`${endDate}T23:59:59.999Z`);
      filter.createdAt = range;
    }

    if (search?.trim()) {
      const searchRegex = new RegExp(escapeRegex(search.trim()), "i");
      const searchOr = [
        { serviceNumber: searchRegex },
        { "customerSnapshot.name": searchRegex },
        { "customerSnapshot.mobile": searchRegex },
        { "items.serialNumberText": searchRegex },
        { "items.productName": searchRegex },
        { originBranchName: searchRegex },
        { serviceBranchName: searchRegex },
      ];
      filter.$and = [...(filter.$and || []), { $or: searchOr }];
    }

    const [services, total] = await Promise.all([
      Service.find(filter)
        .populate("items.productId", "name category modelNumber")
        .populate("items.productSerialId", "serialNumber")
        .populate("originBranchId", "name code")
        .populate("serviceBranchId", "name code")
        .populate("serviceVendorId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Service.countDocuments(filter),
    ]);

    return successResponse(res, "Services retrieved successfully", {
      services,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.max(1, Math.ceil(total / parseInt(limit))),
      },
    });
  } catch (error) {
    console.error("Get All Services Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve services", 500);
  }
};
