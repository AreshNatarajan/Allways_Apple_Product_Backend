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
 * AVAILABLE right now", grouped by configuration.
 *
 * "Configuration" groups on this unit's own ProductSerial.description.main
 * (the free-text note entered at Purchase time, e.g. "iPhone 14 plus /
 * 128GB") when present; a unit whose description was left blank falls
 * back to "<Product name> / <Model number>" (both guaranteed non-blank
 * for a serialized product, see Product.modal.js's validators) so it's
 * never silently dropped from the report.
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
            {
                $addFields: {
                    trimmedDescription: { $trim: { input: { $ifNull: ["$description.main", ""] } } },
                },
            },
            {
                $addFields: {
                    configuration: {
                        $cond: [
                            { $ne: ["$trimmedDescription", ""] },
                            "$trimmedDescription",
                            { $concat: ["$product.name", " / ", { $ifNull: ["$product.modelNumber", ""] }] },
                        ],
                    },
                },
            },
            { $group: { _id: "$configuration", qty: { $sum: 1 } } },
            { $sort: { _id: 1 } },
            { $project: { _id: 0, configuration: "$_id", qty: 1 } },
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
