// controllers/dashboard/getDashboardController.js
import mongoose from "mongoose";
import Branch from "../../models/Branch.modal.js";
import Product from "../../models/Product.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Purchase from "../../models/Purchase.modal.js";
import Sale from "../../models/Sale.modal.js";
import Customer from "../../models/Customer.modal.js";
import Vendor from "../../models/Vendor.modal.js";
import Transfer from "../../models/Transfer.modal.js";
import PendingReceive from "../../models/PendingReceive.modal.js";
import StockMovement from "../../models/StockMovement.model.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

/**
 * 📊 DASHBOARD CONTROLLER
 *
 * Same endpoint (GET /api/dashboard/stats) and response envelope as
 * before - every existing top-level key (filter/branches/summary/
 * salesOverview/charts/alerts/recentActivities) is kept and now
 * computes real numbers (see bug notes below); new sections are added
 * alongside, never replacing, so nothing that already reads this
 * endpoint breaks.
 *
 * Bug fixes carried by this rewrite (all silently wrong before):
 * - Sale has no top-level `profit` field (only `totalProfit`, set by
 *   createSale.controller.js's real margin/GST-aware profit logic) -
 *   every `$sum:"$profit"` aggregation always summed to 0.
 * - Sale.items has no `totalPrice` field (that name only exists on
 *   Purchase items) - the real field is `items.finalAmount`.
 * - Transfer.status has no "PENDING" enum value (real enum: PROCESSING/
 *   PACKED/DISPATCHED/RECEIVED/CANCELLED) - "in flight, not yet
 *   received" is DISPATCHED (stock already left the source branch,
 *   reserved at creation - see createTransfer.controller.js).
 * - Low stock read the legacy Inventory collection; migrated to
 *   ProductSerial/BatchStock (same threshold convention already
 *   established in inventory/getInventoryDashboard.controller.js: a
 *   product's available quantity >5 = fine, <=5 = low, 0 = out).
 *
 * 🔍 Query Parameters:
 * - branchId: filter by specific branch (SUPER_ADMIN only)
 * - period: today | thisWeek | thisMonth | thisQuarter | thisYear | all
 * - trendRange: today | 7d | 30d | 3m | 6m | 1y (Revenue Trend chart's
 *   own filter set - deliberately independent of `period`, which has a
 *   different option list)
 *
 * 👤 Role Behavior:
 * - SUPER_ADMIN: sees all branches, or one via `branchId`
 * - BRANCH_ADMIN / STAFF: always forced to their own branch
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Purchase can be a CENTRAL purchase split across branches via per-item
// branchId, or a plain single-branch (BRANCH) purchase - same pattern
// already proven in getAllPurchases.controller.js.
const purchaseBranchCondition = (id) => ({ $or: [{ branchId: id }, { "items.branchId": id }] });

const itemQuantity = (item) => (item.isSerialized ? 1 : item.quantity || 0);

export const getDashboardController = async (req, res) => {
    try {
        const { branchId, period = "thisMonth", trendRange = "30d" } = req.query;
        const user = req.user;
        const isSuperAdmin = user?.role === "SUPER_ADMIN";

        // ============================================================
        // BRANCH SCOPING (unchanged from the existing controller)
        // ============================================================
        let selectedBranchId = null;
        let branchObjectId = null;

        if (isSuperAdmin && branchId) {
            selectedBranchId = branchId;
            branchObjectId = new mongoose.Types.ObjectId(branchId);
        } else if (!isSuperAdmin) {
            selectedBranchId = user?.branchId;
            if (!selectedBranchId) {
                return errorResponse(res, "Branch not assigned to user", 400);
            }
            branchObjectId = new mongoose.Types.ObjectId(selectedBranchId);
        }

        let branchName = "All Branches";
        if (selectedBranchId) {
            const branch = await Branch.findById(selectedBranchId).select("name").lean();
            branchName = branch?.name || "Unknown Branch";
        }

        let branches = [];
        if (isSuperAdmin) {
            branches = await Branch.find({ isActive: true, isDeleted: false })
                .select("_id name code")
                .sort({ name: 1 })
                .lean();
        }

        const saleBranchMatch = branchObjectId ? { branchId: branchObjectId } : {};
        const purchaseBranchMatch = branchObjectId ? purchaseBranchCondition(branchObjectId) : {};

        const dateFilter = getDateFilter(period);

        // Global Settings thresholds - fetched once, threaded into every
        // stock-status computation below instead of a hardcoded constant.
        const gstConfig = await getOrCreateGstConfig();
        const stockThresholds = {
            serializedLowStockThreshold: gstConfig.inventory.serializedLowStockThreshold,
            nonSerializedLowStockThreshold: gstConfig.inventory.nonSerializedLowStockThreshold,
        };

        // ============================================================
        // RUN EVERYTHING IN PARALLEL
        // ============================================================
        const [
            summary,
            salesOverview,
            salesTrend,
            topProductsLegacy,
            topCustomersLegacy,
            lowStockLegacy,
            pendingTransfersLegacy,
            pendingReceivesLegacy,
            recentActivities,

            kpisToday,
            profitSummary,
            profitTrend,
            revenueTrend,
            paymentStatus,
            paymentMethodStats,
            stockOverview,
            sections,
            branchComparison,
        ] = await Promise.all([
            getSummary(saleBranchMatch, purchaseBranchMatch, branchObjectId),
            getSalesOverview(saleBranchMatch),
            getSalesTrend(saleBranchMatch, dateFilter, period),
            getTopProductsLegacy(saleBranchMatch, dateFilter),
            getTopCustomersLegacy(saleBranchMatch, dateFilter),
            getLowStockLegacyShape(branchObjectId, stockThresholds),
            getPendingTransfersList(branchObjectId),
            getPendingReceivesList(branchObjectId, 10),
            getRecentActivities(branchObjectId),

            getTodayKpis(saleBranchMatch, purchaseBranchMatch),
            getProfitSummary(saleBranchMatch),
            getProfitTrend(saleBranchMatch),
            getRevenueTrend(saleBranchMatch, purchaseBranchMatch, trendRange),
            getPaymentStatus(saleBranchMatch, purchaseBranchMatch),
            getPaymentMethodStats(saleBranchMatch),
            getStockOverview(branchObjectId, stockThresholds),
            getPeriodSections(saleBranchMatch, purchaseBranchMatch, dateFilter),
            isSuperAdmin ? getBranchComparison(dateFilter) : Promise.resolve([]),
        ]);

        const pendingPayments = await getPendingPayments(saleBranchMatch, purchaseBranchMatch);
        const largeOutstandingCustomers = await getLargeOutstandingCustomers(saleBranchMatch);

        const payload = {
            filter: {
                branchId: selectedBranchId || null,
                branchName,
                period,
                trendRange,
                isSuperAdmin,
            },
            branches,

            // ---- existing keys, kept, now bug-fixed ----
            summary,
            salesOverview,
            charts: {
                salesTrend,
                topProducts: topProductsLegacy,
                topCustomers: topCustomersLegacy,
            },
            alerts: {
                lowStock: lowStockLegacy,
                pendingTransfers: pendingTransfersLegacy,
                pendingReceives: pendingReceivesLegacy,
            },
            recentActivities,

            // ---- new keys ----
            kpis: {
                today: kpisToday,
                overview: {
                    totalProducts: summary.totalProducts,
                    inventoryValue: round2(stockOverview.purchaseValue),
                    lowStockProducts: stockOverview.lowStockCount,
                    pendingReceives: summary.pendingReceives,
                    pendingPayments: round2(pendingPayments.total),
                },
            },
            profitSummary,
            revenueTrend,
            profitTrend,
            salesByCategory: sections.salesByCategory,
            paymentStatus,
            paymentMethodStats,
            inventoryOverview: {
                serializedProducts: stockOverview.serializedProducts,
                nonSerializedProducts: stockOverview.nonSerializedProducts,
                availableSerials: stockOverview.availableSerials,
                soldSerials: stockOverview.soldSerials,
                pendingReceive: summary.pendingReceives,
                transferPending: summary.pendingTransfers,
            },
            lowStockWidget: stockOverview.lowStockWidget,
            topSellingProducts: sections.topSellingProducts,
            bestCustomers: sections.bestCustomers,
            bestVendors: sections.bestVendors,
            branchComparison,
            recentSales: await getRecentSales(saleBranchMatch),
            recentPurchases: await getRecentPurchases(purchaseBranchMatch),
            pendingReceivesList: await getPendingReceivesList(branchObjectId, 15),
            alertsPanel: {
                lowStock: stockOverview.lowStockCount,
                outOfStock: stockOverview.outOfStockCount,
                pendingReceives: summary.pendingReceives,
                pendingPayments: round2(pendingPayments.total),
                largeOutstandingCustomers,
                transferPending: summary.pendingTransfers,
            },
        };

        // ---- profit is SUPER_ADMIN-only, everywhere on this screen -
        // stripped once, centrally, right before the response goes out,
        // rather than threading a role flag through every aggregation
        // above. Keys are deleted entirely (never zeroed), matching the
        // same "omit, don't fake a zero" convention already established
        // for Inventory's cost fields (stripInventoryCostFields.js).
        // branchComparison needs no handling here - it's already `[]`
        // for non-SUPER_ADMIN via the existing gate a few lines up.
        if (!isSuperAdmin) {
            delete payload.profitSummary;
            delete payload.profitTrend;
            delete payload.kpis.today.profit;
            for (const bucket of Object.values(payload.salesOverview)) delete bucket.profit;
            for (const row of payload.charts.salesTrend) delete row.profit;
            for (const row of payload.charts.topProducts) delete row.profit;
            for (const row of payload.charts.topCustomers) delete row.totalProfit;
            for (const row of payload.topSellingProducts) delete row.profit;
        }

        return successResponse(res, "Dashboard data retrieved successfully", payload);
    } catch (error) {
        console.error("Dashboard Error:", error);
        return errorResponse(res, error.message || "Failed to load dashboard", 500);
    }
};

// ============================================================
// 📅 DATE HELPERS
// ============================================================

const getDateFilter = (period) => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    switch (period) {
        case "today": return { $gte: startOfDay };
        case "thisWeek": return { $gte: startOfWeek };
        case "thisMonth": return { $gte: startOfMonth };
        case "thisQuarter": return { $gte: startOfQuarter };
        case "thisYear": return { $gte: startOfYear };
        case "all":
        default: return null;
    }
};

const TREND_RANGE_CONFIG = {
    today: { days: 0, granularity: "hour" },
    "7d": { days: 7, granularity: "day" },
    "30d": { days: 30, granularity: "day" },
    "3m": { days: 90, granularity: "week" },
    "6m": { days: 180, granularity: "week" },
    "1y": { days: 365, granularity: "month" },
};

const getTrendStart = (range) => {
    const config = TREND_RANGE_CONFIG[range] || TREND_RANGE_CONFIG["30d"];
    const start = new Date();
    if (config.days === 0) {
        start.setHours(0, 0, 0, 0);
    } else {
        start.setDate(start.getDate() - config.days);
    }
    return { start, granularity: config.granularity };
};

const hourKey = (d) => new Date(d).toISOString().slice(0, 13) + ":00";
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const weekKey = (d) => {
    const date = new Date(d);
    const firstDayOfWeek = new Date(date);
    firstDayOfWeek.setDate(date.getDate() - date.getDay());
    return firstDayOfWeek.toISOString().slice(0, 10);
};
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

const keyFnFor = (granularity) =>
    granularity === "hour" ? hourKey : granularity === "day" ? dayKey : granularity === "week" ? weekKey : monthKey;

// ============================================================
// 📊 SUMMARY (existing key, bug-fixed)
// ============================================================

const getSummary = async (saleBranchMatch, purchaseBranchMatch, branchObjectId) => {
    const customerFilter = branchObjectId ? { branchId: branchObjectId } : {};
    const totalCustomers = await Customer.countDocuments({ ...customerFilter, isDeleted: false });
    const totalVendors = await Vendor.countDocuments({ isDeleted: false, isActive: true });
    const totalProducts = await Product.countDocuments({ isDeleted: false, isActive: true });

    const serialFilter = branchObjectId ? { currentBranchId: branchObjectId } : {};
    const totalSerials = await ProductSerial.countDocuments({ ...serialFilter, status: "AVAILABLE", isDeleted: false });

    const [salesAgg] = await Sale.aggregate([
        { $match: { status: "COMPLETED", isDeleted: false, ...saleBranchMatch } },
        { $group: { _id: null, totalSales: { $sum: 1 }, totalRevenue: { $sum: "$totalAmount" }, totalProfit: { $sum: "$totalProfit" } } },
    ]);
    const salesData = salesAgg || { totalSales: 0, totalRevenue: 0, totalProfit: 0 };

    const [purchaseAgg] = await Purchase.aggregate([
        { $match: { status: "COMPLETED", isDeleted: false, ...purchaseBranchMatch } },
        { $group: { _id: null, totalPurchases: { $sum: 1 }, totalPurchaseAmount: { $sum: "$totalAmount" } } },
    ]);
    const purchaseData = purchaseAgg || { totalPurchases: 0, totalPurchaseAmount: 0 };

    const pendingReceiveFilter = branchObjectId ? { branchId: branchObjectId } : {};
    const pendingReceives = await PendingReceive.countDocuments({ ...pendingReceiveFilter, status: { $in: ["PENDING", "PARTIAL"] } });

    const transferFilter = branchObjectId
        ? { $or: [{ sourceBranchId: branchObjectId }, { destinationBranchId: branchObjectId }] }
        : {};
    // Real Transfer.status enum has no "PENDING" value - DISPATCHED is
    // the "in flight, not yet received" state.
    const pendingTransfers = await Transfer.countDocuments({ ...transferFilter, status: "DISPATCHED", isDeleted: false });

    return {
        totalCustomers,
        totalVendors,
        totalProducts,
        totalSerials,
        totalSales: salesData.totalSales,
        totalRevenue: round2(salesData.totalRevenue),
        totalProfit: round2(salesData.totalProfit),
        totalPurchases: purchaseData.totalPurchases,
        totalPurchaseAmount: round2(purchaseData.totalPurchaseAmount),
        pendingReceives,
        pendingTransfers,
    };
};

// ============================================================
// 📈 SALES OVERVIEW (existing key, bug-fixed via $facet - one query)
// ============================================================

const getSalesOverview = async (saleBranchMatch) => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay()); weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);

    const [result] = await Sale.aggregate([
        { $match: { status: "COMPLETED", isDeleted: false, ...saleBranchMatch } },
        {
            $facet: {
                today: [{ $match: { saleDate: { $gte: todayStart } } }, { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$totalAmount" }, profit: { $sum: "$totalProfit" } } }],
                thisWeek: [{ $match: { saleDate: { $gte: weekStart } } }, { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$totalAmount" }, profit: { $sum: "$totalProfit" } } }],
                thisMonth: [{ $match: { saleDate: { $gte: monthStart } } }, { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$totalAmount" }, profit: { $sum: "$totalProfit" } } }],
                thisYear: [{ $match: { saleDate: { $gte: yearStart } } }, { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$totalAmount" }, profit: { $sum: "$totalProfit" } } }],
            },
        },
    ]);

    const pick = (arr) => arr?.[0] ? { count: arr[0].count, revenue: round2(arr[0].revenue), profit: round2(arr[0].profit) } : { count: 0, revenue: 0, profit: 0 };

    return {
        today: pick(result.today),
        thisWeek: pick(result.thisWeek),
        thisMonth: pick(result.thisMonth),
        thisYear: pick(result.thisYear),
    };
};

// ============================================================
// 📊 SALES TREND (existing key, bug-fixed)
// ============================================================

const getSalesTrend = async (saleBranchMatch, dateFilter, period) => {
    const match = { status: "COMPLETED", isDeleted: false, ...saleBranchMatch };
    if (dateFilter) match.saleDate = dateFilter;

    let groupBy, sortBy, dateFormat;
    switch (period) {
        case "today":
            groupBy = { hour: { $hour: "$saleDate" } }; sortBy = { "_id.hour": 1 }; dateFormat = { hour: "$_id.hour" };
            break;
        case "thisQuarter":
        case "thisYear":
            groupBy = { month: { $month: "$saleDate" }, year: { $year: "$saleDate" } }; sortBy = { "_id.year": 1, "_id.month": 1 }; dateFormat = { month: "$_id.month", year: "$_id.year" };
            break;
        default:
            groupBy = { day: { $dayOfMonth: "$saleDate" }, month: { $month: "$saleDate" } }; sortBy = { "_id.month": 1, "_id.day": 1 }; dateFormat = { day: "$_id.day", month: "$_id.month" };
    }

    return Sale.aggregate([
        { $match: match },
        { $group: { _id: groupBy, revenue: { $sum: "$totalAmount" }, profit: { $sum: "$totalProfit" }, count: { $sum: 1 } } },
        { $sort: sortBy },
        { $project: { date: dateFormat, revenue: 1, profit: 1, count: 1 } },
    ]);
};

// ============================================================
// 🏆 LEGACY TOP PRODUCTS / TOP CUSTOMERS (existing keys, bug-fixed)
// ============================================================

const getTopProductsLegacy = async (saleBranchMatch, dateFilter) => {
    const match = { status: "COMPLETED", isDeleted: false, ...saleBranchMatch };
    if (dateFilter) match.saleDate = dateFilter;

    return Sale.aggregate([
        { $match: match },
        { $unwind: "$items" },
        {
            $group: {
                _id: "$items.productId",
                productName: { $first: "$items.productName" },
                productCode: { $first: "$items.productCode" },
                totalSold: { $sum: { $cond: [{ $eq: ["$items.isSerialized", true] }, 1, "$items.quantity"] } },
                revenue: { $sum: "$items.finalAmount" },
                profit: { $sum: "$items.profit" },
            },
        },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
        { $project: { productId: "$_id", productName: 1, productCode: 1, totalSold: 1, revenue: { $round: ["$revenue", 2] }, profit: { $round: ["$profit", 2] } } },
    ]);
};

const getTopCustomersLegacy = async (saleBranchMatch, dateFilter) => {
    const match = { status: "COMPLETED", isDeleted: false, ...saleBranchMatch };
    if (dateFilter) match.saleDate = dateFilter;

    const rows = await Sale.aggregate([
        { $match: match },
        { $group: { _id: "$customerId", totalPurchases: { $sum: 1 }, totalSpent: { $sum: "$totalAmount" }, totalProfit: { $sum: "$totalProfit" } } },
        { $sort: { totalSpent: -1 } },
        { $limit: 10 },
        { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "customer" } },
        { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
        { $project: { customerId: "$_id", customerName: { $ifNull: ["$customer.name", "Unknown"] }, mobile: "$customer.mobile", totalPurchases: 1, totalSpent: { $round: ["$totalSpent", 2] }, totalProfit: { $round: ["$totalProfit", 2] } } },
    ]);
    return rows;
};

// ============================================================
// 🕐 TODAY KPIs
// ============================================================

const getTodayKpis = async (saleBranchMatch, purchaseBranchMatch) => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);

    const [todaySales, todayPurchases] = await Promise.all([
        Sale.find({ status: "COMPLETED", isDeleted: false, saleDate: { $gte: todayStart }, ...saleBranchMatch })
            .select("totalAmount totalProfit customerId")
            .lean(),
        Purchase.find({ status: "COMPLETED", isDeleted: false, purchaseDate: { $gte: todayStart }, ...purchaseBranchMatch })
            .select("totalAmount")
            .lean(),
    ]);

    const sales = round2(todaySales.reduce((s, x) => s + (x.totalAmount || 0), 0));
    const profit = round2(todaySales.reduce((s, x) => s + (x.totalProfit || 0), 0));
    const purchase = round2(todayPurchases.reduce((s, x) => s + (x.totalAmount || 0), 0));
    const customers = new Set(todaySales.map((s) => s.customerId?.toString()).filter(Boolean)).size;

    return { sales, purchase, profit, customers, invoices: todaySales.length };
};

// ============================================================
// 💰 PROFIT SUMMARY - real Sale.totalProfit throughout, never
// sellingPrice - purchasePrice
// ============================================================

const getProfitSummary = async (saleBranchMatch) => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart = new Date(now.getFullYear(), 0, 1);

    const [result] = await Sale.aggregate([
        { $match: { status: "COMPLETED", isDeleted: false, ...saleBranchMatch } },
        {
            $facet: {
                today: [{ $match: { saleDate: { $gte: todayStart } } }, { $group: { _id: null, profit: { $sum: "$totalProfit" } } }],
                thisMonth: [{ $match: { saleDate: { $gte: monthStart } } }, { $group: { _id: null, profit: { $sum: "$totalProfit" } } }],
                thisYear: [{ $match: { saleDate: { $gte: yearStart } } }, { $group: { _id: null, profit: { $sum: "$totalProfit" } } }],
                overall: [{ $group: { _id: null, profit: { $sum: "$totalProfit" } } }],
            },
        },
    ]);

    const pick = (arr) => round2(arr?.[0]?.profit || 0);
    return {
        today: pick(result.today),
        thisMonth: pick(result.thisMonth),
        thisYear: pick(result.thisYear),
        overall: pick(result.overall),
    };
};

const getProfitTrend = async (saleBranchMatch) => {
    const yearAgo = new Date(); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);

    const [result] = await Sale.aggregate([
        { $match: { status: "COMPLETED", isDeleted: false, saleDate: { $gte: yearAgo }, ...saleBranchMatch } },
        {
            $facet: {
                daily: [
                    { $match: { saleDate: { $gte: monthAgo } } },
                    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$saleDate" } }, profit: { $sum: "$totalProfit" } } },
                    { $sort: { _id: 1 } },
                ],
                monthly: [
                    { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$saleDate" } }, profit: { $sum: "$totalProfit" } } },
                    { $sort: { _id: 1 } },
                ],
            },
        },
    ]);

    return {
        daily: (result.daily || []).map((d) => ({ date: d._id, profit: round2(d.profit) })),
        monthly: (result.monthly || []).map((m) => ({ month: m._id, profit: round2(m.profit) })),
    };
};

// ============================================================
// 📈 REVENUE TREND - Sales vs Purchase, own trendRange filter
// ============================================================

const getRevenueTrend = async (saleBranchMatch, purchaseBranchMatch, trendRange) => {
    const { start, granularity } = getTrendStart(trendRange);
    const keyFn = keyFnFor(granularity);

    const [sales, purchases] = await Promise.all([
        Sale.find({ status: "COMPLETED", isDeleted: false, saleDate: { $gte: start }, ...saleBranchMatch }).select("saleDate totalAmount").lean(),
        Purchase.find({ status: "COMPLETED", isDeleted: false, purchaseDate: { $gte: start }, ...purchaseBranchMatch }).select("purchaseDate totalAmount").lean(),
    ]);

    const buckets = new Map();
    for (const s of sales) {
        if (!s.saleDate) continue;
        const key = keyFn(s.saleDate);
        if (!buckets.has(key)) buckets.set(key, { sales: 0, purchase: 0 });
        buckets.get(key).sales += s.totalAmount || 0;
    }
    for (const p of purchases) {
        if (!p.purchaseDate) continue;
        const key = keyFn(p.purchaseDate);
        if (!buckets.has(key)) buckets.set(key, { sales: 0, purchase: 0 });
        buckets.get(key).purchase += p.totalAmount || 0;
    }

    const points = [...buckets.entries()]
        .map(([date, v]) => ({ date, sales: round2(v.sales), purchase: round2(v.purchase) }))
        .sort((a, b) => a.date.localeCompare(b.date));

    return { range: trendRange, points };
};

// ============================================================
// 💳 PAYMENT STATUS - current-state (not period-scoped): a payment
// status distribution should reflect real current exposure, not reset
// when the date filter changes.
// ============================================================

const getPaymentStatus = async (saleBranchMatch, purchaseBranchMatch) => {
    const [saleRows, purchaseRows] = await Promise.all([
        Sale.aggregate([
            { $match: { status: "COMPLETED", isDeleted: false, ...saleBranchMatch } },
            { $group: { _id: "$paymentStatus", count: { $sum: 1 }, amount: { $sum: "$totalAmount" } } },
        ]),
        Purchase.aggregate([
            { $match: { status: "COMPLETED", isDeleted: false, ...purchaseBranchMatch } },
            { $group: { _id: "$paymentStatus", count: { $sum: 1 }, amount: { $sum: "$totalAmount" } } },
        ]),
    ]);

    const saleMap = Object.fromEntries(saleRows.map((r) => [r._id, r]));
    const purchaseMap = Object.fromEntries(purchaseRows.map((r) => [r._id, r]));

    return {
        sale: {
            paid: saleMap.PAID?.count || 0,
            partial: saleMap.PARTIAL?.count || 0,
            unpaid: saleMap.UNPAID?.count || 0,
            paidAmount: round2(saleMap.PAID?.amount || 0),
            partialAmount: round2(saleMap.PARTIAL?.amount || 0),
            unpaidAmount: round2(saleMap.UNPAID?.amount || 0),
        },
        purchase: {
            paid: purchaseMap.PAID?.count || 0,
            partial: purchaseMap.PARTIAL?.count || 0,
            unpaid: purchaseMap.PENDING?.count || 0,
            paidAmount: round2(purchaseMap.PAID?.amount || 0),
            partialAmount: round2(purchaseMap.PARTIAL?.amount || 0),
            unpaidAmount: round2(purchaseMap.PENDING?.amount || 0),
        },
    };
};

// ============================================================
// 💳 PAYMENT METHOD BREAKDOWN - total collected by CASH/UPI/CARD/etc,
// summed across every payment entry in Sale.paymentDetails[] (a sale
// can be paid in installments/multiple methods, so this unwinds the
// array rather than grouping on a single top-level field). Visible to
// every role - operational (how customers pay), not cost/profit data.
// ============================================================

const getPaymentMethodStats = async (saleBranchMatch) => {
    const rows = await Sale.aggregate([
        { $match: { status: "COMPLETED", isDeleted: false, ...saleBranchMatch } },
        { $unwind: "$paymentDetails" },
        { $group: { _id: "$paymentDetails.paymentMethod", amount: { $sum: "$paymentDetails.amount" }, transactionCount: { $sum: 1 } } },
        { $sort: { amount: -1 } },
    ]);
    return rows.map((r) => ({ paymentMethod: r._id || "CASH", amount: round2(r.amount), transactionCount: r.transactionCount }));
};

const getPendingPayments = async (saleBranchMatch, purchaseBranchMatch) => {
    const [[saleAgg], [purchaseAgg]] = await Promise.all([
        Sale.aggregate([
            { $match: { status: "COMPLETED", isDeleted: false, pendingAmount: { $gt: 0 }, ...saleBranchMatch } },
            { $group: { _id: null, total: { $sum: "$pendingAmount" } } },
        ]),
        Purchase.aggregate([
            { $match: { status: "COMPLETED", isDeleted: false, pendingAmount: { $gt: 0 }, ...purchaseBranchMatch } },
            { $group: { _id: null, total: { $sum: "$pendingAmount" } } },
        ]),
    ]);
    return { total: (saleAgg?.total || 0) + (purchaseAgg?.total || 0) };
};

const getLargeOutstandingCustomers = async (saleBranchMatch) => {
    const rows = await Sale.aggregate([
        { $match: { status: "COMPLETED", isDeleted: false, pendingAmount: { $gt: 0 }, ...saleBranchMatch } },
        { $group: { _id: "$customerId", outstandingAmount: { $sum: "$pendingAmount" } } },
        { $sort: { outstandingAmount: -1 } },
        { $limit: 5 },
        { $lookup: { from: "customers", localField: "_id", foreignField: "_id", as: "customer" } },
        { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
        { $project: { customerId: "$_id", customerName: { $ifNull: ["$customer.name", "Unknown"] }, outstandingAmount: { $round: ["$outstandingAmount", 2] } } },
    ]);
    return rows;
};

// ============================================================
// 📦 STOCK OVERVIEW - single pass over ProductSerial + BatchStock.
// Thresholds are read from Global Settings by the caller and passed
// in here - serialized/non-serialized are independently configurable,
// so the two loops below each use their own threshold rather than one
// shared constant.
// ============================================================

const getStockOverview = async (branchObjectId, thresholds) => {
    const { serializedLowStockThreshold, nonSerializedLowStockThreshold } = thresholds;
    const serialFilter = { isDeleted: false };
    if (branchObjectId) serialFilter.currentBranchId = branchObjectId;
    const batchFilter = { status: { $ne: "CANCELLED" } };
    if (branchObjectId) batchFilter.branchId = branchObjectId;

    const [serials, batchStocks, serializedProducts, nonSerializedProducts] = await Promise.all([
        ProductSerial.find(serialFilter).select("productId status purchasePrice sellingPrice").lean(),
        BatchStock.find(batchFilter).select("productId availableQuantity purchasePrice sellingPrice status").lean(),
        Product.countDocuments({ isSerialized: true, isActive: true, isDeleted: false }),
        Product.countDocuments({ isSerialized: false, isActive: true, isDeleted: false }),
    ]);

    let availableSerials = 0, soldSerials = 0, purchaseValue = 0;
    const serialAvailByProduct = new Map();
    const serializedProductIds = new Set();

    for (const s of serials) {
        const key = s.productId?.toString();
        if (key) serializedProductIds.add(key);
        if (s.status === "AVAILABLE") {
            availableSerials++;
            purchaseValue += s.purchasePrice || 0;
            if (key) serialAvailByProduct.set(key, (serialAvailByProduct.get(key) || 0) + 1);
        }
        if (s.status === "SOLD") soldSerials++;
    }

    const batchAvailByProduct = new Map();
    const nonSerializedProductIds = new Set();
    for (const b of batchStocks) {
        const key = b.productId?.toString();
        if (key) nonSerializedProductIds.add(key);
        if (b.status === "ACTIVE") purchaseValue += (b.availableQuantity || 0) * (b.purchasePrice || 0);
        if (key) batchAvailByProduct.set(key, (batchAvailByProduct.get(key) || 0) + (b.availableQuantity || 0));
    }

    let lowStockCount = 0, outOfStockCount = 0;
    const lowStockProductIds = [];
    for (const [productId, qty] of serialAvailByProduct) {
        if (qty === 0) { outOfStockCount++; lowStockProductIds.push({ productId, qty, isSerialized: true }); }
        else if (qty <= serializedLowStockThreshold) { lowStockCount++; lowStockProductIds.push({ productId, qty, isSerialized: true }); }
    }
    for (const productId of serializedProductIds) {
        if (!serialAvailByProduct.has(productId)) { outOfStockCount++; lowStockProductIds.push({ productId, qty: 0, isSerialized: true }); }
    }
    for (const [productId, qty] of batchAvailByProduct) {
        if (qty === 0) { outOfStockCount++; lowStockProductIds.push({ productId, qty, isSerialized: false }); }
        else if (qty <= nonSerializedLowStockThreshold) { lowStockCount++; lowStockProductIds.push({ productId, qty, isSerialized: false }); }
    }
    for (const productId of nonSerializedProductIds) {
        if (!batchAvailByProduct.has(productId)) { outOfStockCount++; lowStockProductIds.push({ productId, qty: 0, isSerialized: false }); }
    }

    const widgetIds = lowStockProductIds.slice(0, 20).map((x) => x.productId).filter(Boolean);
    const products = widgetIds.length
        ? await Product.find({ _id: { $in: widgetIds } }).select("name").lean()
        : [];
    const nameMap = new Map(products.map((p) => [p._id.toString(), p.name]));

    const lowStockWidget = lowStockProductIds.slice(0, 20).map(({ productId, qty, isSerialized }) => ({
        productId,
        productName: nameMap.get(productId) || "Unknown Product",
        availableQty: qty,
        minimumLevel: isSerialized ? serializedLowStockThreshold : nonSerializedLowStockThreshold,
        status: qty === 0 ? "OUT_OF_STOCK" : "LOW_STOCK",
    }));

    return {
        availableSerials,
        soldSerials,
        purchaseValue,
        lowStockCount,
        outOfStockCount,
        lowStockWidget,
        serializedProducts,
        nonSerializedProducts,
    };
};

const getLowStockLegacyShape = async (branchObjectId, thresholds) => {
    const overview = await getStockOverview(branchObjectId, thresholds);
    return {
        count: overview.lowStockCount,
        outOfStock: overview.outOfStockCount,
        items: overview.lowStockWidget.filter((i) => i.status === "LOW_STOCK"),
        outOfStockItems: overview.lowStockWidget.filter((i) => i.status === "OUT_OF_STOCK"),
    };
};

// ============================================================
// 🔀 PERIOD-SCOPED SECTIONS - one Sale fetch + one Purchase fetch
// drive Sales by Category, Top Selling Products, and the count/amount
// half of Best Customers/Best Vendors, in a single pass each.
// ============================================================

const getPeriodSections = async (saleBranchMatch, purchaseBranchMatch, dateFilter) => {
    const saleMatch = { status: "COMPLETED", isDeleted: false, ...saleBranchMatch };
    if (dateFilter) saleMatch.saleDate = dateFilter;
    const purchaseMatch = { status: "COMPLETED", isDeleted: false, ...purchaseBranchMatch };
    if (dateFilter) purchaseMatch.purchaseDate = dateFilter;

    const [sales, purchases] = await Promise.all([
        Sale.find(saleMatch)
            .populate("items.productId", "category")
            .populate("customerId", "name")
            .select("items customerId customerSnapshot totalAmount")
            .lean(),
        Purchase.find(purchaseMatch)
            .populate("vendorId", "name")
            .select("vendorId vendorSnapshot totalAmount purchaseDate")
            .lean(),
    ]);

    // ---- Sales by Category + Top Selling Products, one pass ----
    const categoryMap = new Map();
    const productMap = new Map();
    const customerMap = new Map();

    for (const sale of sales) {
        for (const item of sale.items || []) {
            const category = item.productId?.category || "Uncategorized";
            if (!categoryMap.has(category)) categoryMap.set(category, { revenue: 0, quantity: 0 });
            const cEntry = categoryMap.get(category);
            const qty = itemQuantity(item);
            cEntry.revenue += item.finalAmount || 0;
            cEntry.quantity += qty;

            const pKey = (item.productId?._id || item.productId)?.toString() || item.productName;
            if (!productMap.has(pKey)) productMap.set(pKey, { productId: item.productId?._id || item.productId || null, productName: item.productName || "Unknown Product", soldQty: 0, revenue: 0, profit: 0 });
            const pEntry = productMap.get(pKey);
            pEntry.soldQty += qty;
            pEntry.revenue += item.finalAmount || 0;
            pEntry.profit += item.profit || 0;
        }

        // customerId is populated above (name only) - flattened back to a
        // plain id/name pair here, same pattern already used for
        // vendorId/vendorName below. customerSnapshot.name is a fallback
        // for a genuinely deleted customer only - it's never reliably
        // set at sale-creation time (createSale.controller.js doesn't
        // stamp it), so it must never be tried FIRST or every customer
        // name here collapses to "Unknown Customer".
        const customerDoc = sale.customerId;
        const cKey = customerDoc?._id ? customerDoc._id.toString() : "unknown";
        if (!customerMap.has(cKey)) {
            customerMap.set(cKey, {
                customerId: customerDoc?._id || null,
                customerName: customerDoc?.name || sale.customerSnapshot?.name || "Unknown Customer",
                purchaseCount: 0,
                salesAmount: 0,
            });
        }
        const custEntry = customerMap.get(cKey);
        custEntry.purchaseCount += 1;
        custEntry.salesAmount += sale.totalAmount || 0;
    }

    const salesByCategory = [...categoryMap.entries()]
        .map(([category, v]) => ({ category, revenue: round2(v.revenue), quantity: v.quantity }))
        .sort((a, b) => b.revenue - a.revenue);

    const topSellingProducts = [...productMap.values()]
        .map((p) => ({ ...p, revenue: round2(p.revenue), profit: round2(p.profit) }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

    // ---- Best Vendors, one pass over purchases ----
    const vendorMap = new Map();
    for (const purchase of purchases) {
        const vKey = purchase.vendorId?._id ? purchase.vendorId._id.toString() : (purchase.vendorId ? purchase.vendorId.toString() : "unknown");
        if (!vendorMap.has(vKey)) {
            vendorMap.set(vKey, {
                vendorId: purchase.vendorId?._id || purchase.vendorId || null,
                vendorName: purchase.vendorId?.name || purchase.vendorSnapshot?.name || "Unknown Vendor",
                purchaseAmount: 0,
                transactions: 0,
                lastPurchaseDate: null,
            });
        }
        const vEntry = vendorMap.get(vKey);
        vEntry.purchaseAmount += purchase.totalAmount || 0;
        vEntry.transactions += 1;
        if (!vEntry.lastPurchaseDate || new Date(purchase.purchaseDate) > new Date(vEntry.lastPurchaseDate)) {
            vEntry.lastPurchaseDate = purchase.purchaseDate;
        }
    }

    const bestVendors = [...vendorMap.values()]
        .map((v) => ({ ...v, purchaseAmount: round2(v.purchaseAmount) }))
        .sort((a, b) => b.purchaseAmount - a.purchaseAmount)
        .slice(0, 10);

    // ---- Best Customers - merge period counts with all-time outstanding ----
    const customerIds = [...customerMap.keys()].filter((k) => k !== "unknown");
    const outstandingRows = customerIds.length
        ? await Sale.aggregate([
            { $match: { status: "COMPLETED", isDeleted: false, pendingAmount: { $gt: 0 }, customerId: { $in: customerIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
            { $group: { _id: "$customerId", outstanding: { $sum: "$pendingAmount" } } },
        ])
        : [];
    const outstandingMap = new Map(outstandingRows.map((r) => [r._id.toString(), r.outstanding]));

    const bestCustomers = [...customerMap.values()]
        .map((c) => ({
            ...c,
            salesAmount: round2(c.salesAmount),
            outstandingAmount: round2(outstandingMap.get(c.customerId?.toString()) || 0),
        }))
        .sort((a, b) => b.salesAmount - a.salesAmount)
        .slice(0, 10);

    return { salesByCategory, topSellingProducts, bestVendors, bestCustomers };
};

// ============================================================
// 🌿 BRANCH COMPARISON (SUPER_ADMIN only)
// ============================================================

const getBranchComparison = async (dateFilter) => {
    const saleMatch = { status: "COMPLETED", isDeleted: false };
    if (dateFilter) saleMatch.saleDate = dateFilter;
    const purchaseMatch = { status: "COMPLETED", isDeleted: false };
    if (dateFilter) purchaseMatch.purchaseDate = dateFilter;

    const [sales, purchases, branches, serials, batchStocks] = await Promise.all([
        Sale.find(saleMatch).select("branchId totalAmount totalProfit").lean(),
        Purchase.find(purchaseMatch).select("branchId items.branchId items.totalPrice totalAmount poType").lean(),
        Branch.find({ isActive: true, isDeleted: false }).select("name").lean(),
        ProductSerial.find({ isDeleted: false, status: "AVAILABLE" }).select("currentBranchId purchasePrice").lean(),
        BatchStock.find({ status: "ACTIVE" }).select("branchId availableQuantity purchasePrice").lean(),
    ]);

    const byBranch = new Map(branches.map((b) => [b._id.toString(), { branchId: b._id, branchName: b.name, sales: 0, purchase: 0, profit: 0, inventoryValue: 0 }]));

    for (const s of sales) {
        const key = s.branchId?.toString();
        if (key && byBranch.has(key)) {
            byBranch.get(key).sales += s.totalAmount || 0;
            byBranch.get(key).profit += s.totalProfit || 0;
        }
    }
    for (const p of purchases) {
        if (p.poType === "CENTRAL") {
            for (const item of p.items || []) {
                const key = item.branchId?.toString();
                if (key && byBranch.has(key)) byBranch.get(key).purchase += (item.totalPrice || 0);
            }
        } else {
            const key = p.branchId?.toString();
            if (key && byBranch.has(key)) byBranch.get(key).purchase += p.totalAmount || 0;
        }
    }
    for (const s of serials) {
        const key = s.currentBranchId?.toString();
        if (key && byBranch.has(key)) byBranch.get(key).inventoryValue += s.purchasePrice || 0;
    }
    for (const b of batchStocks) {
        const key = b.branchId?.toString();
        if (key && byBranch.has(key)) byBranch.get(key).inventoryValue += (b.availableQuantity || 0) * (b.purchasePrice || 0);
    }

    return [...byBranch.values()]
        .map((b) => ({ ...b, sales: round2(b.sales), purchase: round2(b.purchase), profit: round2(b.profit), inventoryValue: round2(b.inventoryValue) }))
        .sort((a, b) => b.sales - a.sales);
};

// ============================================================
// 🧾 RECENT SALES / PURCHASES (existing route, exact spec columns)
// ============================================================

const getRecentSales = async (saleBranchMatch) => {
    const sales = await Sale.find({ isDeleted: false, ...saleBranchMatch })
        .populate("customerId", "name")
        .select("saleNumber customerId customerSnapshot totalAmount paymentStatus saleDate")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();

    return sales.map((s) => ({
        _id: s._id,
        invoice: s.saleNumber,
        customer: s.customerId?.name || s.customerSnapshot?.name || "-",
        amount: round2(s.totalAmount || 0),
        paymentStatus: s.paymentStatus,
        saleDate: s.saleDate,
    }));
};

const getRecentPurchases = async (purchaseBranchMatch) => {
    const purchases = await Purchase.find({ isDeleted: false, ...purchaseBranchMatch })
        .populate("vendorId", "name")
        .select("purchaseNumber vendorId vendorSnapshot totalAmount status purchaseDate")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();

    return purchases.map((p) => ({
        _id: p._id,
        purchaseNumber: p.purchaseNumber,
        vendor: p.vendorId?.name || p.vendorSnapshot?.name || "-",
        amount: round2(p.totalAmount || 0),
        status: p.status,
        purchaseDate: p.purchaseDate,
    }));
};

// ============================================================
// 📦 PENDING RECEIVES
// ============================================================

const getPendingReceivesList = async (branchObjectId, limit) => {
    const filter = branchObjectId ? { branchId: branchObjectId } : {};
    const pendingReceives = await PendingReceive.find({ ...filter, status: { $in: ["PENDING", "PARTIAL"] } })
        .populate("purchaseId", "purchaseNumber")
        .populate("branchId", "name code")
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    return pendingReceives.map((pr) => {
        let assignedQty = 0, receivedQty = 0;
        (pr.items || []).forEach((item) => {
            assignedQty += item.orderedQuantity || 0;
            receivedQty += item.receivedQuantity || 0;
        });
        return {
            pendingReceiveId: pr._id,
            purchaseNumber: pr.purchaseId?.purchaseNumber || pr.purchaseNumber || "-",
            branchName: pr.branchId?.name || pr.branchName || "-",
            assignedQty,
            receivedQty,
            status: pr.status,
            createdAt: pr.createdAt,
        };
    });
};

const getPendingTransfersList = async (branchObjectId) => {
    const transferFilter = { isDeleted: false };
    if (branchObjectId) {
        transferFilter.$or = [{ sourceBranchId: branchObjectId }, { destinationBranchId: branchObjectId }];
    }

    const transfers = await Transfer.find({ ...transferFilter, status: "DISPATCHED" })
        .populate("sourceBranchId", "name code")
        .populate("destinationBranchId", "name code")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();

    return transfers.map((t) => ({
        transferId: t._id,
        transferNumber: t.transferNumber,
        sourceBranch: t.sourceBranchId?.name || t.sourceBranchName,
        destinationBranch: t.destinationBranchId?.name || t.destinationBranchName,
        status: t.status,
        totalItems: t.summary?.totalItems || 0,
        totalQuantity: t.summary?.totalQuantity || 0,
        receivedQuantity: t.summary?.totalReceived || 0,
        createdAt: t.createdAt,
    }));
};

// ============================================================
// 🔔 RECENT ACTIVITY TIMELINE - one StockMovement query gives
// type/performedAt/performedByName for free (Icon/Color/User/Time),
// instead of the old 4-way Sale+Purchase+Transfer+ReceiveHistory
// merge. Payment events are synthesized from data already on hand
// where cheap; "Return" is honestly omitted (no backing schema data
// anywhere - never fabricated).
// ============================================================

const getRecentActivities = async (branchObjectId) => {
    const filter = branchObjectId ? { branchId: branchObjectId } : {};
    const movements = await StockMovement.find(filter)
        .sort({ performedAt: -1 })
        .limit(20)
        .lean();

    return movements.map((m) => ({
        type: m.type,
        message: buildActivityMessage(m),
        timestamp: m.performedAt,
        performedByName: m.performedByName || "",
        referenceType: m.referenceType,
        referenceId: m.referenceId,
    }));
};

const buildActivityMessage = (m) => {
    switch (m.type) {
        case "PURCHASE_RECEIVE_DIRECT":
        case "PURCHASE_RECEIVE_CENTRAL":
            return `Stock received (${Math.abs(m.quantityDelta)} unit${Math.abs(m.quantityDelta) === 1 ? "" : "s"})`;
        case "TRANSFER_OUT":
            return `Transferred out (${Math.abs(m.quantityDelta)} unit${Math.abs(m.quantityDelta) === 1 ? "" : "s"})`;
        case "TRANSFER_IN":
            return `Transferred in (${Math.abs(m.quantityDelta)} unit${Math.abs(m.quantityDelta) === 1 ? "" : "s"})`;
        case "SALE":
            return `Sold (${Math.abs(m.quantityDelta)} unit${Math.abs(m.quantityDelta) === 1 ? "" : "s"})`;
        case "DAMAGE":
            return "Marked as damaged";
        case "REJECT":
            return "Rejected during receive";
        case "ADJUSTMENT":
            return "Manual stock adjustment";
        default:
            return m.type;
    }
};
