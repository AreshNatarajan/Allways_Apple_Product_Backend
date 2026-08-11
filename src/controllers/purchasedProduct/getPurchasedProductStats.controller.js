import ProductSerial from "../../models/ProductSerial.modal.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getPurchasedProductStatsController =
    async (req, res) => {

        try {

            const [
                totalProducts,
                availableProducts,
                soldProducts,
                returnedProducts,
            ] = await Promise.all([

                ProductSerial.countDocuments(),

                ProductSerial.countDocuments({
                    status: "AVAILABLE",
                }),

                ProductSerial.countDocuments({
                    status: "SOLD",
                }),

                ProductSerial.countDocuments({
                    status: "RETURNED",
                }),
            ]);

            return successResponse(
                res,
                "Purchased product stats retrieved successfully",
                {
                    totalProducts,
                    availableProducts,
                    soldProducts,
                    returnedProducts,
                }
            );

        } catch (error) {

            console.error(
                "Purchased Product Stats Error:",
                error
            );

            return errorResponse(
                res,
                "Failed to retrieve purchased product stats",
                500
            );

        }

    };