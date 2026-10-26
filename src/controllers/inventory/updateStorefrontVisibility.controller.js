// controllers/inventory/updateStorefrontVisibility.controller.js
import ProductSerial from "../../models/ProductSerial.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

/**
 * "Show on E-commerce Website" for one serialized unit. Changes ONLY
 * ProductSerial.showOnStorefront - status, stock, prices, sales and every
 * ERP screen are untouched; the public storefront queries skip units
 * where it is false.
 *
 * Route requires storefront.manage (same grant as the Online Catalog).
 * Branch users may change only units currently at their own branch;
 * SUPER_ADMIN any branch.
 */
export const updateStorefrontVisibilityController = async (req, res) => {
    try {
        const { serialNumber } = req.params;
        const { showOnStorefront } = req.body;

        if (!serialNumber || !serialNumber.trim()) {
            return errorResponse(res, "Serial number is required", 400);
        }
        if (typeof showOnStorefront !== "boolean") {
            return errorResponse(res, "showOnStorefront must be true or false", 400);
        }

        const item = await ProductSerial.findOne({
            serialNumber: serialNumber.trim().toUpperCase(),
            isDeleted: false,
        });
        if (!item) {
            return errorResponse(res, "Serial not found", 404);
        }

        const user = req.user;
        if (user.role !== "SUPER_ADMIN" && String(item.currentBranchId || "") !== String(user.branchId || "")) {
            return errorResponse(res, "Only the branch holding this unit can change its website visibility", 403);
        }

        item.showOnStorefront = showOnStorefront;
        await item.save({ validateModifiedOnly: true });

        return successResponse(res, showOnStorefront ? "Shown on the website" : "Hidden from the website", {
            serialNumber: item.serialNumber,
            showOnStorefront: item.showOnStorefront,
        });
    } catch (error) {
        console.error("Update Storefront Visibility Error:", error);
        return errorResponse(res, "Failed to update website visibility", 500);
    }
};
