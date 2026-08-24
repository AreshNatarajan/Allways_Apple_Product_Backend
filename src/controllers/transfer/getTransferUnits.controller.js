// controllers/transfer/getTransferUnits.controller.js
import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Product from "../../models/Product.modal.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// The granular "what can I actually pick" list for one product at one
// branch, used by the Create Transfer screen once a product has been
// chosen from the browse step (getProductAvailability.controller.js,
// unchanged - that one only ever returns aggregate counts). Serialized:
// every individual AVAILABLE serial number, so the user can pick exact
// units. Non-serialized: every ACTIVE batch with its own available
// quantity, so the user can pick a specific batch (or split across a
// few) - this app has no FIFO auto-consumption anywhere, matching the
// same rule Sale already follows.
export const getTransferUnitsController = async (req, res) => {
    try {
        const { productId } = req.params;
        const { sourceBranchId } = req.query;

        if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
            return errorResponse(res, "Invalid product ID", 400);
        }
        if (!sourceBranchId) {
            return errorResponse(res, "Source branch ID is required", 400);
        }
        const { error: branchError } = await resolveActiveBranch(sourceBranchId);
        if (branchError) {
            return errorResponse(res, `Source branch: ${branchError}`, 400);
        }

        const product = await Product.findOne({ _id: productId, isDeleted: false }).select("name isSerialized modelNumber").lean();
        if (!product) {
            return errorResponse(res, "Product not found", 404);
        }

        if (product.isSerialized) {
            const serials = await ProductSerial.find({
                productId,
                currentBranchId: sourceBranchId,
                status: "AVAILABLE",
                isDeleted: false,
            })
                .select("serialNumber")
                .sort({ createdAt: 1 })
                .lean();

            return successResponse(res, "Transfer units retrieved successfully", {
                isSerialized: true,
                serials: serials.map((s) => ({ _id: s._id, serialNumber: s.serialNumber, modelNumber: product.modelNumber || "" })),
                batches: [],
            });
        }

        const batches = await BatchStock.find({
            productId,
            branchId: sourceBranchId,
            status: "ACTIVE",
            availableQuantity: { $gt: 0 },
        })
            .select("batchNumber availableQuantity")
            .sort({ createdAt: 1 })
            .lean();

        return successResponse(res, "Transfer units retrieved successfully", {
            isSerialized: false,
            serials: [],
            batches: batches.map((b) => ({ batchStockId: b._id, batchNumber: b.batchNumber, availableQuantity: b.availableQuantity })),
        });
    } catch (error) {
        console.error("Get Transfer Units Error:", error);
        return errorResponse(res, "Failed to retrieve transfer units", 500);
    }
};
