// controllers/dashboard/getRevenueTrendDetail.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import Purchase from "../../models/Purchase.modal.js";
import { getReturnExchangeAdjustmentRows } from "../../services/reports/getReturnExchangeAdjustments.js";
import { TREND_RANGE_CONFIG, resolveBucketRange } from "../../services/dashboard/trendBucketing.js";
import { errorResponse, successResponse } from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Purchase can be a CENTRAL purchase split across branches via per-item
// branchId, or a plain single-branch (BRANCH) purchase - same pattern
// already used in getDashboard.controller.js/getAllPurchases.controller.js.
const purchaseBranchCondition = (id) => ({ $or: [{ branchId: id }, { "items.branchId": id }] });

// Drill-down for one point on the Dashboard's Revenue Trend chart
// (RevenueTrendChart.jsx) - same flow as Profit Trend's drill-down
// (getProfitTrendDetail.controller.js): the user clicks a bucket and
// sees exactly which Sales and Purchases made up that point, not just
// the chart's own summed total. Revenue Trend has its own range/
// granularity system (hour/day/week/month, see trendBucketing.js) that
// Profit Trend doesn't - `range` selects the granularity, `key` is
// whatever that bucket's own key function produced (e.g. "2026-09-19"
// for a day, "2026-09" for a month), and resolveBucketRange reverses
// that back into the exact [start, end) UTC window the chart used, so
// the same documents that fed the clicked point are the ones returned
// here.
export const getRevenueTrendDetailController = async (req, res) => {
    try {
        const { range = "30d", key, branchId } = req.query;
        const user = req.user;
        const isSuperAdmin = user?.role === "SUPER_ADMIN";

        if (!key) {
            return errorResponse(res, "A key is required", 400);
        }
        const config = TREND_RANGE_CONFIG[range];
        if (!config) {
            return errorResponse(res, `Unknown range "${range}"`, 400);
        }

        const { start, end } = resolveBucketRange(config.granularity, key);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            return errorResponse(res, "Invalid key for this range's granularity", 400);
        }

        // Same branch-scoping rule as every other Dashboard endpoint:
        // SUPER_ADMIN may request any branch (or none, for all), but a
        // BRANCH_ADMIN/STAFF is always forced to their own branch,
        // regardless of what the query string asks for - this is a
        // standalone endpoint, not fed through getDashboardController's
        // own central branch resolution, so it has to redo that check
        // itself rather than trust the client.
        const effectiveBranchId = isSuperAdmin ? branchId : user?.branchId;
        const branchObjectId = effectiveBranchId && mongoose.Types.ObjectId.isValid(effectiveBranchId)
            ? new mongoose.Types.ObjectId(effectiveBranchId)
            : null;
        const saleBranchMatch = branchObjectId ? { branchId: branchObjectId } : {};
        const purchaseBranchMatch = branchObjectId ? purchaseBranchCondition(branchObjectId) : {};

        const [sales, purchases, adjustmentRows] = await Promise.all([
            Sale.find({
                status: "COMPLETED",
                isDeleted: false,
                saleDate: { $gte: start, $lt: end },
                ...saleBranchMatch,
            })
                .select("saleNumber saleDate customerId customerSnapshot totalAmount")
                .populate("customerId", "name")
                .sort({ saleDate: -1 })
                .lean(),
            Purchase.find({
                status: "COMPLETED",
                isDeleted: false,
                purchaseDate: { $gte: start, $lt: end },
                ...purchaseBranchMatch,
            })
                .select("purchaseNumber purchaseDate vendorId vendorSnapshot totalAmount")
                .populate("vendorId", "name")
                .sort({ purchaseDate: -1 })
                .lean(),
            // Same shared service the chart's own getRevenueTrend folds
            // into its "sales" bucket (a Return/Exchange delta on top of
            // the raw Sale total) - included here too so a bucket whose
            // total doesn't match its listed Sales' plain sum is still
            // fully explained, not a mystery. `end` is exclusive here
            // but the service's own `end` is inclusive ($lte) - back off
            // by 1ms so a row exactly on the next bucket's boundary
            // isn't double-counted into this one (same fix as
            // getProfitTrendDetail.controller.js).
            getReturnExchangeAdjustmentRows({ branchObjectId, start, end: new Date(end.getTime() - 1) }),
        ]);

        const formattedSales = sales.map((sale) => ({
            _id: sale._id,
            saleNumber: sale.saleNumber,
            saleDate: sale.saleDate,
            customerName: sale.customerSnapshot?.name || sale.customerId?.name || "Walk-in",
            totalAmount: round2(sale.totalAmount || 0),
        }));

        const formattedPurchases = purchases.map((purchase) => ({
            _id: purchase._id,
            purchaseNumber: purchase.purchaseNumber,
            purchaseDate: purchase.purchaseDate,
            vendorName: purchase.vendorSnapshot?.name || purchase.vendorId?.name || "-",
            totalAmount: round2(purchase.totalAmount || 0),
        }));

        const formattedAdjustments = adjustmentRows
            .map((r) => ({
                type: r.type,
                _id: r._id,
                saleId: r.saleId,
                saleNumber: r.saleNumber,
                date: r.date,
                salesAdjustment: round2(r.salesAdjustment),
            }))
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        return successResponse(res, "Revenue trend detail retrieved successfully", {
            range,
            key,
            granularity: config.granularity,
            sales: formattedSales,
            purchases: formattedPurchases,
            adjustments: formattedAdjustments,
        });
    } catch (error) {
        console.error("Get Revenue Trend Detail Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve revenue trend detail", 500);
    }
};
