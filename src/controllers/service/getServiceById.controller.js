// controllers/service/getServiceById.controller.js
import Service from "../../models/Service.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const getServiceByIdController = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const service = await Service.findOne({ _id: id, isDeleted: false })
      .populate("customerId", "name mobile email address")
      .populate("items.productId", "name category modelNumber")
      .populate("items.productSerialId", "serialNumber status")
      .populate("items.acquisitionPurchaseId", "purchaseNumber purchaseDate totalAmount")
      .populate("originBranchId", "name code address phones")
      .populate("serviceBranchId", "name code address phones")
      .populate("serviceVendorId", "name phone email address")
      .populate("createdBy", "name email")
      .lean();

    if (!service) return errorResponse(res, "Service not found", 404);

    if (user.role !== "SUPER_ADMIN") {
      const userBranchId = user?.branchId?.toString();
      const originId = service.originBranchId?._id?.toString();
      const serviceBranchIdStr = service.serviceBranchId?._id?.toString();
      if (userBranchId !== originId && userBranchId !== serviceBranchIdStr) {
        return errorResponse(res, "Access denied. You can only view services involving your branch.", 403);
      }
    }

    return successResponse(res, "Service details retrieved successfully", { service });
  } catch (error) {
    console.error("Get Service By ID Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve service details", 500);
  }
};
