// controllers/inventory/getInventoryDashboard.controller.js
import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const emptyDashboardPayload = () => ({
    totalProducts: 0,
    serializedProducts: 0,
    nonSerializedProducts: 0,
    inventoryPurchaseValue: 0,
    inventorySellingValue: 0,
    estimatedProfit: 0,
    totalAvailableStock: 0,
    soldUnits: 0,
    lowStock: 0,
    outOfStock: 0,
});

// Read-only over ProductSerial (serialized) + BatchStock (non-serialized) -
// never the legacy Inventory collection, which is flagged elsewhere in
// this codebase as redundant with BatchStock. Branch scoping is inline
// (SUPER_ADMIN optional filter, everyone else forced to their own
// branch) rather than the shared getBranchFilter middleware, which
// leaves STAFF unscoped - same fix already applied to Sale/Customer.
export const getInventoryDashboardController = async (req, res) => {
    try {
        const { branchId } = req.query;
        const user = req.user;

        const gstConfig = await getOrCreateGstConfig();
        const { serializedLowStockThreshold, nonSerializedLowStockThreshold } = gstConfig.inventory;

        let scopedBranchId = null; // null = SUPER_ADMIN viewing every branch
        if (user.role === "SUPER_ADMIN") {
            if (branchId && branchId !== "ALL" && mongoose.Types.ObjectId.isValid(branchId)) {
                scopedBranchId = branchId;
            }
        } else {
            if (!user.branchId) {
                return successResponse(res, "Inventory dashboard retrieved successfully", emptyDashboardPayload());
            }
            scopedBranchId = user.branchId;
        }

        // ---- serialized side ----
        const serialFilter = { isDeleted: false };
        if (scopedBranchId) {
            serialFilter.$or = [
                { currentBranchId: scopedBranchId },
                { assignedBranchId: scopedBranchId, status: "IN_TRANSIT" },
            ];
        }
        const serials = await ProductSerial.find(serialFilter)
            .select("productId status purchasePrice sellingPrice")
            .lean();

        // ---- non-serialized side ----
        const batchStockFilter = {};
        if (scopedBranchId) batchStockFilter.branchId = scopedBranchId;
        const batchStocks = await BatchStock.find(batchStockFilter)
            .select("productId availableQuantity soldQuantity purchasePrice sellingPrice status")
            .lean();

        // ---- single pass over both sets ----
        const serializedProductIds = new Set();
        const nonSerializedProductIds = new Set();
        const serialAvailByProduct = new Map();
        const batchAvailByProduct = new Map();

        let purchaseValue = 0;
        let sellingValue = 0;
        let availableStock = 0;
        let soldUnits = 0;

        for (const s of serials) {
            const key = s.productId.toString();
            serializedProductIds.add(key);
            if (s.status === "AVAILABLE") {
                purchaseValue += s.purchasePrice || 0;
                sellingValue += s.sellingPrice || 0;
                availableStock += 1;
                serialAvailByProduct.set(key, (serialAvailByProduct.get(key) || 0) + 1);
            }
            if (s.status === "SOLD") soldUnits += 1;
        }

        for (const b of batchStocks) {
            const key = b.productId.toString();
            nonSerializedProductIds.add(key);
            if (b.status === "ACTIVE") {
                purchaseValue += (b.availableQuantity || 0) * (b.purchasePrice || 0);
                sellingValue += (b.availableQuantity || 0) * (b.sellingPrice || 0);
            }
            availableStock += b.availableQuantity || 0;
            soldUnits += b.soldQuantity || 0;
            batchAvailByProduct.set(key, (batchAvailByProduct.get(key) || 0) + (b.availableQuantity || 0));
        }

        // ---- low/out-of-stock, per product, across the FULL product
        // universe seen above (not just products with an AVAILABLE
        // entry) so a product with zero remaining stock is still
        // counted as out-of-stock rather than silently dropped ----
        let lowStock = 0;
        let outOfStock = 0;
        for (const productIdStr of serializedProductIds) {
            const qty = serialAvailByProduct.get(productIdStr) || 0;
            if (qty === 0) outOfStock++;
            else if (qty <= serializedLowStockThreshold) lowStock++;
        }
        for (const productIdStr of nonSerializedProductIds) {
            const qty = batchAvailByProduct.get(productIdStr) || 0;
            if (qty === 0) outOfStock++;
            else if (qty <= nonSerializedLowStockThreshold) lowStock++;
        }

        const allProductIds = new Set([...serializedProductIds, ...nonSerializedProductIds]);
        purchaseValue = round2(purchaseValue);
        sellingValue = round2(sellingValue);

        return successResponse(res, "Inventory dashboard retrieved successfully", {
            totalProducts: allProductIds.size,
            serializedProducts: serializedProductIds.size,
            nonSerializedProducts: nonSerializedProductIds.size,
            inventoryPurchaseValue: purchaseValue,
            inventorySellingValue: sellingValue,
            estimatedProfit: round2(sellingValue - purchaseValue),
            totalAvailableStock: availableStock,
            soldUnits,
            lowStock,
            outOfStock,
        });
    } catch (error) {
        console.error("Get Inventory Dashboard Error:", error);
        return errorResponse(res, "Failed to retrieve inventory dashboard", 500);
    }
};
