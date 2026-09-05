import ProductSerial from "../../models/ProductSerial.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// PUBLIC, unauthenticated - only the categories actually represented
// among currently AVAILABLE serialized units across every branch, not
// the full Product.category enum regardless of real stock - so the
// storefront's filter never offers a category with zero results.
export const getPublicStorefrontCategoriesController = async (req, res) => {
    try {
        const serials = await ProductSerial.find({ isDeleted: false, status: "AVAILABLE" })
            .select("productId")
            .populate("productId", "category")
            .lean();

        const categories = [...new Set(serials.map((s) => s.productId?.category).filter(Boolean))].sort();

        return successResponse(res, "Categories retrieved successfully", { categories });
    } catch (error) {
        console.error("Get Public Storefront Categories Error:", error);
        return errorResponse(res, "Failed to retrieve categories", 500);
    }
};
