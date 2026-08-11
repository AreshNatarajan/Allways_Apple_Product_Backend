import mongoose from "mongoose";
import Product from "../../models/Product.modal.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getProductByIdController = async (
    req,
    res
) => {
    try {

        const { id } = req.params;

        if (!id) {
            return errorResponse(
                res,
                "Product ID is required",
                400
            );
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(
                res,
                "Invalid product ID",
                400
            );
        }

        // Note: Product has no branchId field (products are global, not
        // branch-scoped), so no branch filter is applied here. A prior
        // version of this controller spread getBranchFilter(...) into
        // the query, which silently 404'd every lookup for BRANCH_ADMIN
        // users since no Product document has a branchId to match.
        //
        // Note: no isActive/isDeleted filter at all here. This app has
        // no hard-delete anywhere - deleteProductController's "delete"
        // is a reversible deactivate that (for historical reasons) sets
        // both isActive:false and isDeleted:true together. A deactivated
        // product must still be viewable/reactivatable by id, so this
        // endpoint intentionally does not exclude isDeleted:true docs.
        const product = await Product.findOne({ _id: id });

        if (!product) {
            return errorResponse(
                res,
                "Product not found",
                404
            );
        }

        return successResponse(
            res,
            "Product retrieved successfully",
            product
        );

    } catch (error) {

        console.error(
            "Error retrieving product:",
            error
        );

        return errorResponse(
            res,
            "Internal server error",
            500
        );
    }
};



