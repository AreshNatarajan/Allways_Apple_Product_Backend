// controllers/reports/getDailyStockReport.controller.js
import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Branch from "../../models/Branch.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

/**
 * DAILY STOCK REPORT - a live current-stock snapshot for ONE branch,
 * serialized products only (ProductSerial is the serialized-only
 * table - non-serialized stock lives on BatchStock instead and is
 * deliberately excluded here, per the feature's own scope). Unlike
 * getInOutReport.controller.js (a movement register over a date
 * range), this has no date range at all - it's always "what's
 * AVAILABLE right now". Count-based: one row per physical AVAILABLE
 * unit, not grouped/aggregated by product.
 *
 * "Configuration" is that UNIT's own `description.main` (the per-unit
 * condition/cosmetic note entered at Purchase time - e.g. "mint
 * condition", "small scratch on lid") - never the shared Product name,
 * since two units of the same product can genuinely read differently
 * here. Falls back to the product's own name only when staff left that
 * per-unit description blank, same fallback convention already used for
 * the Sale Invoice's line-item description (buildSaleInvoiceData).
 * `sellingPrice` is this unit's own current asking price, not a batch
 * average - both real ProductSerial fields, nothing computed.
 *
 * Role: any authenticated role, same as /in-out (a stock list, not a
 * financial report - no purchase price/cost ever included). SUPER_ADMIN
 * must pass a single branchId (this report has no "All Branches"
 * concept - the title/filename are always one specific store);
 * BRANCH_ADMIN/STAFF are always forced to their own branch.
 */
export const getDailyStockReportController = async (req, res) => {
    try {
        const user = req.user;
        const isSuperAdmin = user.role === "SUPER_ADMIN";
        const { branchId } = req.query;

        let branchObjectId;
        if (isSuperAdmin) {
            if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
                return errorResponse(res, "Select a branch to generate the stock report", 400);
            }
            branchObjectId = new mongoose.Types.ObjectId(branchId);
        } else {
            if (!user.branchId) return errorResponse(res, "Branch not assigned to user", 400);
            branchObjectId = new mongoose.Types.ObjectId(user.branchId);
        }

        const branch = await Branch.findOne({ _id: branchObjectId, isDeleted: false }).select("name code").lean();
        if (!branch) {
            return errorResponse(res, "Branch not found", 404);
        }

        const rows = await ProductSerial.aggregate([
            { $match: { isDeleted: false, status: "AVAILABLE", currentBranchId: branchObjectId } },
            {
                $lookup: {
                    from: "products",
                    localField: "productId",
                    foreignField: "_id",
                    as: "product",
                },
            },
            { $unwind: "$product" },
            { $match: { "product.isDeleted": false } },
            { $sort: { "product.name": 1, serialNumber: 1 } },
            {
                $project: {
                    _id: 0,
                    configuration: {
                        $let: {
                            vars: { desc: { $ifNull: ["$description.main", ""] } },
                            in: { $cond: [{ $ne: ["$$desc", ""] }, "$$desc", "$product.name"] },
                        },
                    },
                    sellingPrice: { $ifNull: ["$sellingPrice", 0] },
                },
            },
        ]);

        return successResponse(res, "Daily stock report retrieved successfully", {
            branch: { name: branch.name, code: branch.code },
            rows,
        });
    } catch (error) {
        console.error("Get Daily Stock Report Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve daily stock report", 500);
    }
};
