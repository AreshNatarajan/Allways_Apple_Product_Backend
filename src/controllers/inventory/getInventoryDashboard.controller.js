// controllers/inventory/getInventoryDashboard.controller.js
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { canViewInventoryCost } from "../../utils/stripInventoryCostFields.js";
import { resolveInventoryBranchScope } from "../../utils/resolveInventoryBranchScope.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const emptyDashboardPayload = () => ({
    serialized: { products: 0, lowStock: 0, outOfStock: 0, totalStock: 0, availableStock: 0, soldUnits: 0, sellingValue: 0 },
    nonSerialized: { products: 0, lowStock: 0, outOfStock: 0, totalStock: 0, availableStock: 0, soldUnits: 0, sellingValue: 0, totalBatches: 0 },
});

// Read-only over ProductSerial (serialized) + BatchStock (non-serialized) -
// never the legacy Inventory collection, which is flagged elsewhere in
// this codebase as redundant with BatchStock. Branch scoping is inline
// (SUPER_ADMIN optional filter, everyone else forced to their own
// branch) rather than the shared getBranchFilter middleware, which
// leaves STAFF unscoped - same fix already applied to Sale/Customer.
//
// Stats are split per-tab (serialized vs non-serialized) since the two
// have genuinely different underlying models - non-serialized has a
// real "batch" concept (totalBatches) serialized doesn't. purchaseValue/
// profit are SUPER_ADMIN-only and omitted entirely (not zeroed) for
// every other role, matching the never-trust-client/never-expose-cost
// convention used elsewhere in this codebase.
export const getInventoryDashboardController = async (req, res) => {
    try {
        const { branchId } = req.query;
        const user = req.user;
        const canViewCost = canViewInventoryCost(user.role);

        const gstConfig = await getOrCreateGstConfig();
        const { serializedLowStockThreshold, nonSerializedLowStockThreshold } = gstConfig.inventory;

        const branchScope = await resolveInventoryBranchScope(user, branchId);
        if (branchScope.error) {
            return errorResponse(res, branchScope.error, 400);
        }
        if (branchScope.noBranch) {
            return successResponse(res, "Inventory dashboard retrieved successfully", emptyDashboardPayload());
        }
        const scopedBranchId = branchScope.scopedBranchId; // null = SUPER_ADMIN viewing every branch

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

        // ---- serialized pass ----
        const serializedProductIds = new Set();
        const serialAvailByProduct = new Map();
        let serialPurchaseValue = 0;
        let serialSellingValue = 0;
        let serialAvailableStock = 0;
        let serialSoldUnits = 0;

        for (const s of serials) {
            const key = s.productId.toString();
            serializedProductIds.add(key);
            if (s.status === "AVAILABLE") {
                serialPurchaseValue += s.purchasePrice || 0;
                serialSellingValue += s.sellingPrice || 0;
                serialAvailableStock += 1;
                serialAvailByProduct.set(key, (serialAvailByProduct.get(key) || 0) + 1);
            }
            if (s.status === "SOLD") serialSoldUnits += 1;
        }

        let serialLowStock = 0;
        let serialOutOfStock = 0;
        for (const productIdStr of serializedProductIds) {
            const qty = serialAvailByProduct.get(productIdStr) || 0;
            if (qty === 0) serialOutOfStock++;
            else if (qty <= serializedLowStockThreshold) serialLowStock++;
        }

        // ---- non-serialized pass ----
        const nonSerializedProductIds = new Set();
        const batchAvailByProduct = new Map();
        let batchPurchaseValue = 0;
        let batchSellingValue = 0;
        let batchAvailableStock = 0;
        let batchSoldUnits = 0;

        for (const b of batchStocks) {
            const key = b.productId.toString();
            nonSerializedProductIds.add(key);
            if (b.status === "ACTIVE") {
                batchPurchaseValue += (b.availableQuantity || 0) * (b.purchasePrice || 0);
                batchSellingValue += (b.availableQuantity || 0) * (b.sellingPrice || 0);
            }
            batchAvailableStock += b.availableQuantity || 0;
            batchSoldUnits += b.soldQuantity || 0;
            batchAvailByProduct.set(key, (batchAvailByProduct.get(key) || 0) + (b.availableQuantity || 0));
        }

        let nonSerialLowStock = 0;
        let nonSerialOutOfStock = 0;
        for (const productIdStr of nonSerializedProductIds) {
            const qty = batchAvailByProduct.get(productIdStr) || 0;
            if (qty === 0) nonSerialOutOfStock++;
            else if (qty <= nonSerializedLowStockThreshold) nonSerialLowStock++;
        }

        const serialized = {
            products: serializedProductIds.size,
            lowStock: serialLowStock,
            outOfStock: serialOutOfStock,
            totalStock: serialAvailableStock,
            availableStock: serialAvailableStock,
            soldUnits: serialSoldUnits,
            sellingValue: round2(serialSellingValue),
        };
        const nonSerialized = {
            products: nonSerializedProductIds.size,
            lowStock: nonSerialLowStock,
            outOfStock: nonSerialOutOfStock,
            totalStock: batchAvailableStock,
            availableStock: batchAvailableStock,
            soldUnits: batchSoldUnits,
            sellingValue: round2(batchSellingValue),
            totalBatches: batchStocks.length,
        };

        if (canViewCost) {
            serialized.purchaseValue = round2(serialPurchaseValue);
            serialized.profit = round2(serialSellingValue - serialPurchaseValue);
            nonSerialized.purchaseValue = round2(batchPurchaseValue);
            nonSerialized.profit = round2(batchSellingValue - batchPurchaseValue);
        }

        return successResponse(res, "Inventory dashboard retrieved successfully", { serialized, nonSerialized });
    } catch (error) {
        console.error("Get Inventory Dashboard Error:", error);
        return errorResponse(res, "Failed to retrieve inventory dashboard", 500);
    }
};
