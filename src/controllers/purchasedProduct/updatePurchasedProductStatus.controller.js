import ProductSerial from "../../models/ProductSerial.modal.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const updatePurchasedProductStatusController =
    async (req, res) => {

        try {

            const { id } = req.params;

            const { status } = req.body;


            console.log("ID , STATUS UPDATE PURCHASED PEODUCT : " , id, status)

            if (!id) {

                return errorResponse(
                    res,
                    "Product serial ID is required",
                    400
                );

            }

            const allowedStatuses = [
                "AVAILABLE",
                "SOLD",
                "RETURNED",
            ];

            if (
                !status ||
                !allowedStatuses.includes(status)
            ) {

                return errorResponse(
                    res,
                    "Invalid status",
                    400
                );

            }

            const productSerial =
                await ProductSerial.findById(id);

            if (!productSerial) {

                return errorResponse(
                    res,
                    "Purchased product not found",
                    404
                );

            }

            productSerial.status = status;

            await productSerial.save();

            return successResponse(
                res,
                "Status updated successfully",
                productSerial
            );

        } catch (error) {

            console.error(
                "Update Purchased Product Status Error:",
                error
            );

            return errorResponse(
                res,
                "Failed to update status",
                500
            );

        }

    };