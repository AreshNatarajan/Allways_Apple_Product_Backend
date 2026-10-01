// controllers/inventory/updateMaxDiscount.controller.js
import ProductSerial from "../../models/ProductSerial.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

/**
 * Only SUPER_ADMIN may set/change a serialized unit's max discount -
 * matches updateBranch.controller.js's own inline role-check convention
 * (no dedicated permission-catalog entry for this single field yet).
 */
export const updateMaxDiscountController = async (req, res) => {
    try {
        if (req.user.role !== "SUPER_ADMIN") {
            return errorResponse(res, "Access denied. Only SUPER_ADMIN can set max discount", 403);
        }

        const { serialNumber } = req.params;
        const { maxDiscount } = req.body;

        if (!serialNumber || !serialNumber.trim()) {
            return errorResponse(res, "Serial number is required", 400);
        }

        const parsed = Number(maxDiscount);
        if (maxDiscount === undefined || maxDiscount === null || Number.isNaN(parsed) || parsed < 0) {
            return errorResponse(res, "Max discount must be a non-negative number", 400);
        }

        const item = await ProductSerial.findOne({
            serialNumber: serialNumber.trim().toUpperCase(),
            isDeleted: false,
        });

        if (!item) {
            return errorResponse(res, "Serial not found", 404);
        }

        if (parsed > item.sellingPrice) {
            return errorResponse(res, "Max discount cannot exceed the selling price", 400);
        }

        item.maxDiscount = parsed;
        await item.save();

        return successResponse(res, "Max discount updated successfully", { serialNumber: item.serialNumber, maxDiscount: item.maxDiscount });
    } catch (error) {
        console.error("Update Max Discount Error:", error);
        return errorResponse(res, "Failed to update max discount", 500);
    }
};
