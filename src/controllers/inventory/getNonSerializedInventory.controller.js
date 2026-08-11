// controllers/inventory/getNonSerializedInventory.controller.js
import mongoose from "mongoose";
import BatchStock from "../../models/BatchStock.model.js";
import Product from "../../models/Product.modal.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import paginate from "../../utils/pagination.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Quantity > threshold -> In Stock, <=threshold (and >0) -> Low Stock,
// 0 -> Out Of Stock. Threshold is the Global Settings non-serialized
// threshold, never a hardcoded number.
const computeStatus = (qty, threshold) => {
    if (qty === 0) return "OUT_OF_STOCK";
    if (qty <= threshold) return "LOW_STOCK";
    return "IN_STOCK";
};

// Sourced from BatchStock (the real per-branch quantity ledger), never
// the legacy Inventory collection or Batch.aggregate({branchId:...}) -
// Batch has no branchId/availableQuantity field at all, so that older
// query pattern matched nothing. Branch scoping is inline, same
// SUPER_ADMIN-optional/else-own-branch pattern as the serialized
// controller.
export const getNonSerializedInventoryController = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { search = "", status = "", branchId, category, sortBy, sortOrder } = req.query;
        const user = req.user;

        const gstConfig = await getOrCreateGstConfig();
        const threshold = gstConfig.inventory.nonSerializedLowStockThreshold;

        let scopedBranchId = null;
        if (user.role === "SUPER_ADMIN") {
            if (branchId && branchId !== "ALL" && mongoose.Types.ObjectId.isValid(branchId)) {
                scopedBranchId = branchId;
            }
        } else {
            if (!user.branchId) {
                return successResponse(res, "Non-serialized inventory retrieved successfully", {
                    inventory: [],
                    pagination: { total: 0, page: parseInt(page) || 1, limit: parseInt(limit) || 10, totalPages: 1 },
                    filters: { search: "", status: "ALL", category: "ALL", branchId: "ALL" },
                });
            }
            scopedBranchId = user.branchId;
        }

        // CANCELLED batch stock rows are voided, not real historical
        // stock - excluded from the current-quantity aggregate. ACTIVE
        // and EXHAUSTED are both included (an exhausted batch is still
        // real history; it just naturally contributes 0 available units).
        const filter = { status: { $ne: "CANCELLED" } };
        if (scopedBranchId) filter.branchId = scopedBranchId;

        if (category && category !== "ALL") {
            const categoryProducts = await Product.find({ category }).select("_id").lean();
            filter.productId = { $in: categoryProducts.map((p) => p._id) };
        }

        const allStocks = await BatchStock.find(filter)
            .populate("productId", "name category productCode")
            .sort({ createdAt: -1 })
            .lean();

        // Search (product name or code) applied in JS post-fetch - the
        // already-scoped set here is one branch/category slice, small
        // enough that this avoids nesting another $and/$or nesting level
        // in the query.
        let scoped = allStocks;
        if (search && search.trim() !== "" && search !== "undefined") {
            const searchRegex = new RegExp(escapeRegex(search.trim()), "i");
            scoped = scoped.filter(
                (b) => searchRegex.test(b.productCode || "") || searchRegex.test(b.productId?.name || "")
            );
        }

        // ---- group by product (across every in-scope branch when
        // SUPER_ADMIN has no branch filter selected; within the one
        // scoped branch otherwise) ----
        const productMap = new Map();
        for (const b of scoped) {
            if (!b.productId) continue;
            const key = b.productId._id.toString();
            if (!productMap.has(key)) {
                productMap.set(key, {
                    productId: b.productId._id,
                    productName: b.productId.name || "Unknown Product",
                    productCode: b.productCode || "-",
                    category: b.productId.category || "",
                    totalQuantity: 0,
                    batchCount: 0,
                    latestBatch: null,
                });
            }
            const entry = productMap.get(key);
            entry.totalQuantity += b.availableQuantity || 0;
            entry.batchCount += 1;
            // "Selling Price" at the summary-row level is the most
            // recently created batch's price - batches of the same
            // product can legitimately have different selling prices;
            // the full per-batch breakdown is on the detail page.
            if (!entry.latestBatch || new Date(b.createdAt) > new Date(entry.latestBatch.createdAt)) {
                entry.latestBatch = { createdAt: b.createdAt, sellingPrice: b.sellingPrice || 0 };
            }
        }

        let grouped = Array.from(productMap.values()).map((p) => ({
            productId: p.productId,
            productName: p.productName,
            productCode: p.productCode,
            category: p.category,
            totalQuantity: p.totalQuantity,
            batchCount: p.batchCount,
            sellingPrice: p.latestBatch?.sellingPrice || 0,
            status: computeStatus(p.totalQuantity, threshold),
        }));

        if (status && status !== "ALL") {
            grouped = grouped.filter((g) => g.status === status);
        }

        // ---- sort (grouped/derived data, so this is a plain JS sort,
        // not a Mongo-level one) ----
        const sortDir = sortOrder === "asc" ? 1 : -1;
        const sortKey =
            sortBy === "sellingPrice" ? "sellingPrice" :
            sortBy === "productName" ? "productName" :
            sortBy === "quantity" ? "totalQuantity" :
            null;

        if (sortKey) {
            grouped.sort((a, b) => {
                if (a[sortKey] < b[sortKey]) return -1 * sortDir;
                if (a[sortKey] > b[sortKey]) return 1 * sortDir;
                return 0;
            });
        }
        // no explicit sortKey: keep the default order already produced
        // above (most-recently-active product first, via the query's
        // createdAt:-1 feeding the map in that order).

        const total = grouped.length;
        const paginated = grouped.slice(skip, skip + limit);

        return successResponse(res, "Non-serialized inventory retrieved successfully", {
            inventory: paginated,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
            filters: {
                search: search || "",
                status: status || "ALL",
                category: category || "ALL",
                branchId: branchId || "ALL",
                sortBy: sortBy || "",
                sortOrder: sortOrder || "desc",
            },
        });
    } catch (error) {
        console.error("Get Non-Serialized Inventory Error:", error);
        return errorResponse(res, "Failed to retrieve non-serialized inventory", 500);
    }
};
