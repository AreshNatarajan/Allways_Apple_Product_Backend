import ProductSerial from "../../models/ProductSerial.modal.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

/**
 * Check if serial number already exists for a product
 */
export const checkSerialNumberController = async (req, res) => {
    try {
        const { serialNumber, productId, branchId } = req.body;

        // Validate required fields
        if (!serialNumber) {
            return errorResponse(res, "Serial number is required", 400);
        }

        if (!productId) {
            return errorResponse(res, "Product ID is required", 400);
        }

        // if (!branchId) {
        //     return errorResponse(res, "Branch ID is required", 400);
        // }

        // Check if serial number exists for this product and branch
        const existingSerial = await ProductSerial.findOne({
            serialNumber: serialNumber,
            
        });

        if (existingSerial) {
            return successResponse(res, "Serial number already exists", {
                exists: true,
                serialNumber: serialNumber,
                productId: productId,
                status: existingSerial.status,
                message: "This serial number is already in use"
            });
        }

        // Serial number is available
        return successResponse(res, "Serial number is available", {
            exists: false,
            serialNumber: serialNumber,
            productId: productId,
            message: "Serial number is valid and available"
        });

    } catch (error) {
        console.error("Check Serial Number Error:", error);
        return errorResponse(res, "Failed to check serial number", 500);
    }
};
