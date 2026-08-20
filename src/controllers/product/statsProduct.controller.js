import Product from "../../models/Product.modal.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const statsProductController = async (
    req,
    res
) => {

    try {

        // TOTAL / ACTIVE / INACTIVE - deliberately NOT filtered by
        // isDeleted. deleteProductController's "Deactivate" action sets
        // isActive:false AND isDeleted:true together (this app has no
        // hard-delete - isDeleted here just means "deactivated via that
        // specific endpoint", not "gone forever", same convention
        // documented in getProducts.controller.js). Filtering isDeleted
        // here would silently exclude every product deactivated the
        // normal way - the most common deactivation path - from both
        // totalProducts and inactiveProducts, undercounting exactly the
        // number this stat exists to show. Matches the product list's
        // own "All (incl. inactive)" view, which shows the same set.

        // TOTAL PRODUCTS
        const totalProducts =
            await Product.countDocuments({});

        // ACTIVE PRODUCTS
        const activeProducts =
            await Product.countDocuments({
                isActive: true,
            });

        // INACTIVE PRODUCTS
        const inactiveProducts =
            await Product.countDocuments({
                isActive: false,
            });

        const categories =
            await Product.distinct(
                "category",
                {}
            );

        return successResponse(
            res,
            "Product statistics retrieved successfully",
            {
                totalProducts,
                activeProducts,
                inactiveProducts,
                categoriesCount:
                    categories.length,
            }
        );

    } catch (error) {

        console.error(
            "Error retrieving product statistics:",
            error
        );

        return errorResponse(
            res,
            "Internal server error",
            500
        );

    }

};

