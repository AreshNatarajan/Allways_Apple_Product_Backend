// controllers/service/getServiceHistoryById.controller.js
import Service from "../../models/Service.modal.js";
import ServiceHistory from "../../models/ServiceHistory.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const getServiceHistoryByIdController = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const service = await Service.findById(id).select("originBranchId serviceBranchId").lean();
    if (!service) return errorResponse(res, "Service not found", 404);

    if (user.role !== "SUPER_ADMIN") {
      const userBranchId = user?.branchId?.toString();
      if (userBranchId !== service.originBranchId?.toString() && userBranchId !== service.serviceBranchId?.toString()) {
        return errorResponse(res, "Access denied. You can only view services involving your branch.", 403);
      }
    }

    const history = await ServiceHistory.find({ serviceId: id })
      .populate("serviceVendorId", "name")
      .populate("branchId", "name code")
      .sort({ performedAt: 1 })
      .lean();

    return successResponse(res, "Service history retrieved successfully", { serviceId: id, history });
  } catch (error) {
    console.error("Get Service History By ID Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve service history", 500);
  }
};
