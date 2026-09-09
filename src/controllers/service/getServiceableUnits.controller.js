// controllers/service/getServiceableUnits.controller.js
import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Product from "../../models/Product.modal.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// The "which of our own units can I send for service" list for the
// Create Service screen's INVENTORY type - mirrors
// getTransferUnits.controller.js's serialized branch. Service only
// ever tracks a real physical unit (serialized inventory) for the
// INVENTORY type - non-serialized batch stock has no individual
// identity to send out for repair.
export const getServiceableUnitsController = async (req, res) => {
  try {
    const { productId } = req.params;
    const { branchId } = req.query;

    if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return errorResponse(res, "Invalid product ID", 400);
    }
    if (!branchId) return errorResponse(res, "Branch ID is required", 400);
    const { error: branchError } = await resolveActiveBranch(branchId);
    if (branchError) return errorResponse(res, `Branch: ${branchError}`, 400);

    const product = await Product.findOne({ _id: productId, isDeleted: false }).select("name isSerialized modelNumber").lean();
    if (!product) return errorResponse(res, "Product not found", 404);
    if (!product.isSerialized) {
      return errorResponse(res, "Only serialized products can be sent for service from inventory", 400);
    }

    const serials = await ProductSerial.find({
      productId,
      currentBranchId: branchId,
      status: "AVAILABLE",
      isDeleted: false,
    })
      .select("serialNumber purchaseId")
      .sort({ createdAt: 1 })
      .lean();

    return successResponse(res, "Serviceable units retrieved successfully", {
      serials: serials.map((s) => ({ _id: s._id, serialNumber: s.serialNumber, purchaseId: s.purchaseId, modelNumber: product.modelNumber || "" })),
    });
  } catch (error) {
    console.error("Get Serviceable Units Error:", error);
    return errorResponse(res, "Failed to retrieve serviceable units", 500);
  }
};
