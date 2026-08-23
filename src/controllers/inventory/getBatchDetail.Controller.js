// controllers/inventory/getBatchDetail.controller.js
import mongoose from "mongoose";
import BatchStock from "../../models/BatchStock.model.js";
import Product from "../../models/Product.modal.js";
import StockMovement from "../../models/StockMovement.model.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { canViewInventoryCost } from "../../utils/stripInventoryCostFields.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const MOVEMENT_LABELS = {
    PURCHASE_RECEIVE_DIRECT: { label: "Purchase", description: "Received via direct branch purchase" },
    PURCHASE_RECEIVE_CENTRAL: { label: "Receive", description: "Received at branch from a central purchase" },
    TRANSFER_OUT: { label: "Transfer", description: "Dispatched to another branch" },
    TRANSFER_IN: { label: "Transfer", description: "Received from another branch" },
    SALE: { label: "Sale", description: "Sold to a customer" },
    DAMAGE: { label: "Damage", description: "Marked as damaged" },
    REJECT: { label: "Reject", description: "Rejected during receive" },
    ADJUSTMENT: { label: "Adjustment", description: "Manual stock adjustment" },
};

// Fixed to read from BatchStock (the real per-branch ledger: branchId,
// availableQuantity, purchasePrice, sellingPrice all live here) instead
// of the previous Batch.find({branchId,...}) query, which matched
// nothing since Batch has neither field. Every BatchStock row for this
// product+branch is returned regardless of status - EXHAUSTED/CANCELLED
// batches remain visible, per "Inventory never hides historical records."
export const getBatchDetailController = async (req, res) => {
    try {
        const { productId, branchId } = req.params;
        const user = req.user;

        if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
            return errorResponse(res, "Invalid product ID", 400);
        }
        if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
            return errorResponse(res, "Invalid branch ID", 400);
        }

        // Read-only stock visibility is open to every role, not just the
        // batch's own branch - needed so a branch user can check another
        // branch's stock before requesting a Transfer (mirrors the
        // Transfer flow's own unrestricted getProductAvailabilityController).
        // Cost fields below stay SUPER_ADMIN-only regardless of branch.
        const { branch, error: branchError } = await resolveActiveBranch(branchId);
        if (branchError) {
            return errorResponse(res, branchError, 400);
        }

        const product = await Product.findOne({ _id: productId, isDeleted: false })
            .select("name productCode category description hsnCode");
        if (!product) {
            return errorResponse(res, "Product not found", 404);
        }

        const batchStocks = await BatchStock.find({ productId, branchId })
            .populate({
                path: "purchaseId",
                select: "purchaseNumber purchaseDate",
            })
            .sort({ createdAt: -1 })
            .lean();

        const canViewCost = canViewInventoryCost(user.role);

        const batches = batchStocks.map((b) => {
            // Real, additive, per-unit input GST captured at purchase
            // time (never recalculated later - this batch's own frozen
            // rate, unlike a non-serialized SALE, which always uses the
            // current global rate instead - see createSale.controller.js).
            const basePrice = b.purchasePrice || 0;
            const purchaseGstPercent = b.purchaseGstPercent || 0;
            const purchaseGstAmount = purchaseGstPercent > 0
                ? round2((basePrice * purchaseGstPercent) / 100)
                : 0;

            const row = {
                batchId: b.batchId,
                batchStockId: b._id,
                batchNumber: b.batchNumber,
                barcode: b.batchNumber,
                purchaseNumber: b.purchaseId?.purchaseNumber || "-",
                purchaseDate: b.purchaseId?.purchaseDate || b.createdAt,
                quantity: b.quantity || 0,
                availableQuantity: b.availableQuantity || 0,
                soldQuantity: b.soldQuantity || 0,
                damagedQuantity: b.damagedQuantity || 0,
                sellingPrice: b.sellingPrice || 0,
                gstApplicable: !!b.gstApplicable,
                status: b.status,
            };

            if (canViewCost) {
                row.purchasePrice = basePrice;
                row.purchaseGstPercent = purchaseGstPercent;
                row.purchaseGstAmount = purchaseGstAmount;
                // Base + GST, per unit - the actual landed cost of one
                // unit of this batch.
                row.purchaseTotalPrice = round2(basePrice + purchaseGstAmount);
            }

            return row;
        });

        const totalQuantity = batches.reduce((sum, b) => sum + b.quantity, 0);
        const totalAvailableQuantity = batches.reduce((sum, b) => sum + b.availableQuantity, 0);
        const totalBatches = batches.length;

        // ---- timeline across every batch shown here, scoped to this
        // branch (the same physical batch can have separate movement
        // history at a different branch, which must not bleed in) ----
        const batchIds = [...new Set(batchStocks.map((b) => b.batchId.toString()))];
        const movements = batchIds.length > 0
            ? await StockMovement.find({ batchId: { $in: batchIds }, branchId }).sort({ performedAt: 1 }).lean()
            : [];

        const timeline = movements.map((m) => ({
            type: m.type,
            label: MOVEMENT_LABELS[m.type]?.label || m.type,
            description: MOVEMENT_LABELS[m.type]?.description || "",
            date: m.performedAt,
            performedByName: m.performedByName || "",
            quantityDelta: m.quantityDelta,
            future: false,
        }));

        const hasAdjustment = movements.some((m) => m.type === "ADJUSTMENT");
        timeline.push({ type: "RETURN", label: "Return", description: "Not yet supported", date: null, future: true });
        if (!hasAdjustment) {
            timeline.push({ type: "ADJUSTMENT", label: "Adjustment", description: "No adjustments recorded", date: null, future: true });
        }

        return successResponse(res, "Batch details retrieved successfully", {
            product: {
                _id: product._id,
                name: product.name,
                productCode: product.productCode || "-",
                category: product.category || "-",
                description: product.description || "",
                hsnCode: product.hsnCode || "",
            },
            branch: { _id: branch._id, name: branch.name, code: branch.code },
            summary: {
                totalQuantity,
                totalAvailableQuantity,
                totalBatches,
            },
            batches,
            timeline,
        });
    } catch (error) {
        console.error("Get Batch Detail Error:", error);
        return errorResponse(res, "Failed to retrieve batch details", 500);
    }
};
