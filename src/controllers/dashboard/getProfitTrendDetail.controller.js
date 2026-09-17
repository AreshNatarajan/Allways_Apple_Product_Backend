// controllers/dashboard/getProfitTrendDetail.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import { getReturnExchangeAdjustmentRows } from "../../services/reports/getReturnExchangeAdjustments.js";
import { errorResponse, successResponse } from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Drill-down for one point on the Dashboard's Profit Trend chart
// (ProfitTrendChart.jsx) - SUPER_ADMIN clicks a day or month, whether it
// shows a profit or a loss, and sees exactly which Sales (and which
// item within each) made it up, plus any Return/Exchange that landed in
// that same window. Every number here is already frozen on the Sale/
// SaleReturn/SaleExchange documents themselves (profit/profitAfterGst
// per item, refundAmount, priceDifference) - nothing is recomputed, this
// just surfaces the same figures getDashboard.controller.js's own
// profitTrend aggregation already sums, at the individual-document level.
//
// period="daily": key is "YYYY-MM-DD". period="monthly": key is
// "YYYY-MM". Boundaries are UTC to match getDashboard.controller.js's
// own $dateToString bucketing (no explicit timezone there either), so
// the same Sales that contributed to the clicked bucket are the ones
// returned here - never a mismatched, timezone-shifted set.
const resolveRange = (period, key) => {
    if (period === "monthly") {
        const start = new Date(`${key}-01T00:00:00.000Z`);
        const end = new Date(start);
        end.setUTCMonth(end.getUTCMonth() + 1);
        return { start, end };
    }
    const start = new Date(`${key}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start, end };
};

export const getProfitTrendDetailController = async (req, res) => {
    try {
        const { period = "daily", key, branchId } = req.query;

        if (!key || !["daily", "monthly"].includes(period)) {
            return errorResponse(res, "A valid period (daily/monthly) and key are required", 400);
        }
        if (period === "daily" && !/^\d{4}-\d{2}-\d{2}$/.test(key)) {
            return errorResponse(res, "Daily key must be YYYY-MM-DD", 400);
        }
        if (period === "monthly" && !/^\d{4}-\d{2}$/.test(key)) {
            return errorResponse(res, "Monthly key must be YYYY-MM", 400);
        }

        const { start, end } = resolveRange(period, key);
        const branchMatch = branchId && mongoose.Types.ObjectId.isValid(branchId)
            ? { branchId: new mongoose.Types.ObjectId(branchId) }
            : {};

        const branchObjectId = branchId && mongoose.Types.ObjectId.isValid(branchId)
            ? new mongoose.Types.ObjectId(branchId)
            : null;

        const [sales, adjustmentRows] = await Promise.all([
            Sale.find({
                status: "COMPLETED",
                isDeleted: false,
                saleDate: { $gte: start, $lt: end },
                ...branchMatch,
            })
                .select("saleNumber saleDate customerId customerSnapshot totalAmount totalProfit items")
                .populate("customerId", "name")
                .sort({ totalProfit: 1 })
                .lean(),
            // Same shared service getDashboard.controller.js's own
            // profitTrend uses to fold Return/Exchange deltas into a
            // day/month's total - reusing it here (rather than a second,
            // separately-hand-rolled calculation) is what guarantees this
            // drill-down's numbers always agree with the chart's own,
            // including the real purchase-price-aware profit impact of a
            // return (never just -refundAmount, which ignores that the
            // unit's cost is still recovered stock, not a total loss).
            // `end` here is EXCLUSIVE (resolveRange's own convention) but
            // this service's own `end` is inclusive ($lte) - back off by
            // 1ms so a row at exactly the next bucket's start boundary
            // isn't double-counted into this one.
            getReturnExchangeAdjustmentRows({ branchObjectId, start, end: new Date(end.getTime() - 1) }),
        ]);

        const formattedSales = sales.map((sale) => {
            const customerName = sale.customerSnapshot?.name || sale.customerId?.name || "Walk-in";
            const items = (sale.items || []).map((item) => {
                const profit = round2(item.profitAfterGst ?? item.profit ?? 0);
                return {
                    productName: item.productName || "Unknown Product",
                    isSerialized: !!item.isSerialized,
                    serialNumber: item.serialNumber || "",
                    batchNumber: item.batchNumber || "",
                    purchasePrice: item.purchasePrice || 0,
                    sellingPrice: item.sellingPrice || 0,
                    discount: item.discount || 0,
                    profit,
                    isLoss: profit < 0,
                };
            });
            return {
                _id: sale._id,
                saleNumber: sale.saleNumber,
                saleDate: sale.saleDate,
                customerName,
                totalAmount: sale.totalAmount,
                totalProfit: round2(sale.totalProfit || 0),
                isLoss: (sale.totalProfit || 0) < 0,
                items,
            };
        });

        const formattedAdjustments = adjustmentRows
            .map((r) => ({
                type: r.type,
                _id: r._id,
                saleId: r.saleId,
                saleNumber: r.saleNumber,
                date: r.date,
                profitAdjustment: round2(r.profitAdjustment),
                isLoss: r.profitAdjustment < 0,
            }))
            .sort((a, b) => new Date(a.date) - new Date(b.date));

        return successResponse(res, "Profit trend detail retrieved successfully", {
            period,
            key,
            sales: formattedSales,
            adjustments: formattedAdjustments,
        });
    } catch (error) {
        console.error("Get Profit Trend Detail Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve profit trend detail", 500);
    }
};
