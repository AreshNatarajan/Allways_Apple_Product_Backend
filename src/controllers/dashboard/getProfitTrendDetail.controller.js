// controllers/dashboard/getProfitTrendDetail.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import SaleReturn from "../../models/SaleReturn.modal.js";
import SaleExchange from "../../models/SaleExchange.modal.js";
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

        const [sales, returns, exchanges] = await Promise.all([
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
            SaleReturn.find({
                isDeleted: false,
                processStatus: { $ne: "REJECTED" },
                createdAt: { $gte: start, $lt: end },
                ...branchMatch,
            })
                .select("saleId saleNumber createdAt refundAmount items")
                .lean(),
            SaleExchange.find({
                isDeleted: false,
                processStatus: { $ne: "REJECTED" },
                exchangedAt: { $gte: start, $lt: end },
                ...branchMatch,
            })
                .select("saleId saleNumber exchangedAt oldItem newItem priceDifference")
                .lean(),
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

        // Returns don't carry their own frozen purchasePrice on
        // SaleReturn.items[] (see getReturnExchangeAdjustments.js's own
        // comment on this) - a return's profit IMPACT is what matters
        // here (how much it moved this period's total), not a
        // standalone per-item profit figure, so this only ever reports
        // -refundAmount as the adjustment, same sign convention the
        // dashboard's own trend already uses.
        const formattedReturns = returns.map((r) => ({
            type: "RETURN",
            _id: r._id,
            saleId: r.saleId,
            saleNumber: r.saleNumber,
            date: r.createdAt,
            profitAdjustment: round2(-(r.refundAmount || 0)),
            isLoss: true,
        }));

        const formattedExchanges = exchanges.map((ex) => {
            const salesAdjustment = (ex.newItem?.finalAmount || 0) - (ex.oldItem?.finalAmount || 0);
            const costAdjustment = (ex.newItem?.purchasePrice || 0) - (ex.oldItem?.purchasePrice || 0);
            const profitAdjustment = round2(salesAdjustment - costAdjustment);
            return {
                type: "EXCHANGE",
                _id: ex._id,
                saleId: ex.saleId,
                saleNumber: ex.saleNumber,
                date: ex.exchangedAt,
                profitAdjustment,
                isLoss: profitAdjustment < 0,
            };
        });

        return successResponse(res, "Profit trend detail retrieved successfully", {
            period,
            key,
            sales: formattedSales,
            adjustments: [...formattedReturns, ...formattedExchanges].sort((a, b) => new Date(a.date) - new Date(b.date)),
        });
    } catch (error) {
        console.error("Get Profit Trend Detail Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve profit trend detail", 500);
    }
};
