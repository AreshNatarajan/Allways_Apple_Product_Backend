import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const generateBarcodeController =
    async (
        req,
        res
    ) => {

        try {

            const {
                serialNumber,
                productId,
                branchId,
            } = req.body;

            if (
                !serialNumber ||
                !productId ||
                !branchId
            ) {

                return errorResponse(
                    res,
                    "Serial Number, Product ID and Branch ID are required",
                    400
                );

            }

            const barcode =
                serialNumber
                    .trim()
                    .toUpperCase();

            return successResponse(
                res,
                "Barcode generated successfully",
                {
                    serialNumber,
                    barcode,
                    productId,
                    branchId,
                }
            );

        } catch (error) {

            console.error(
                "Generate Barcode Error:",
                error
            );

            return errorResponse(
                res,
                "Failed to generate barcode",
                500
            );

        }

    };