import ProductSerial from "../../models/ProductSerial.modal.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const searchPurchasedProductWithSerialNumber =
    async (req, res) => {

        try {

            const { search = "" } = req.query;
           

            const branchId =  req.user.branchId

            // if (!search.trim()) {

            //     return successResponse(
            //         res,
            //         "Products retrieved successfully",
            //         []
            //     );

            // }

            console.log(branchId, search);

            const products =
                await ProductSerial.find({

                    branchId,

                    status: "AVAILABLE",

                    serialNumber: {
                        $regex: search,
                        $options: "i",
                    },

                })
                    .populate({
                        path: "productId",
                        select:
                            "name sku sellingPrice category",
                    })
                    .sort({
                        createdAt: -1,
                    })
                    .limit(20);

            return successResponse(
                res,
                "Products retrieved successfully",
                products
            );

        } catch (error) {

            console.error(
                "Search Product Error:",
                error
            );

            return errorResponse(
                res,
                "Failed to search products",
                500
            );

        }

    };