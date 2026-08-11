import mongoose from "mongoose";
import Product from "../../models/Product.modal.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

// Reverses deleteProductController. Needed because every other Product
// read/update endpoint filters isDeleted:false, so once a product is
// soft-deleted there is otherwise no way to reach it again.
export const reactivateProductController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid product ID", 400);
        }

        const product = await Product.findById(id);

        if (!product) {
            return errorResponse(res, "Product not found", 404);
        }

        if (!product.isDeleted) {
            return errorResponse(res, "Product is already active", 400);
        }

        product.isDeleted = false;
        product.isActive = true;
        product.deletedAt = null;
        product.updatedBy = req.user._id;
        product.updatedByRole = req.user.role;

        // Same reasoning as deleteProductController: this is a pure
        // status-toggle save and must not be blocked by hsnCode/
        // modelNumbers/productCode validation on legacy documents.
        await product.save({ validateModifiedOnly: true });

        return successResponse(res, "Product reactivated successfully", product);
    } catch (error) {
        console.error("Error reactivating product:", error);

        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern || { field: 1 })[0];
            return errorResponse(
                res,
                `Cannot reactivate: ${field} is already in use by another active product.`,
                409
            );
        }

        return errorResponse(res, "Internal server error", 500);
    }
};
