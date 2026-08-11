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

        // TOTAL PRODUCTS
        const totalProducts =
            await Product.countDocuments({
                isDeleted: false,
            });

        // ACTIVE PRODUCTS
        const activeProducts =
            await Product.countDocuments({
                isDeleted: false,
                isActive: true,
            });

        // INACTIVE PRODUCTS
        const inactiveProducts =
            await Product.countDocuments({
                isDeleted: false,
                isActive: false,
            });

        const categories =
            await Product.distinct(
                "category",
                {
                    isDeleted: false,
                }
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

