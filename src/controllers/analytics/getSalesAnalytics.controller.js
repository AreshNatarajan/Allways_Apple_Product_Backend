// controllers/analytics/getSalesAnalytics.controller.js
//
// GET /api/analytics/sales - Pillar 3 (Sales) of the Business Analytics
// module. Every formula's plain-English definition and the business
// decisions locked in for Slow-moving / New-vs-Returning live in
// shopping-frontend/docs/COMPLETE-ANALYTICS-IMPLEMENTATION-LOGIC.md §4 -
// this controller is that document implemented, nothing more.
//
// Route is SUPER_ADMIN-only (onlySuperAdmin middleware, see
// analytics.router.js), matching the Money/Inventory pillars.
//
// Everything here is period-bound (unlike Inventory, which is mostly
// current-state) - the same startDate/endDate query params as the
// other two pillars, defaulting to this month.

import mongoose from "mongoose";
import Branch from "../../models/Branch.modal.js";
import Product from "../../models/Product.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Purchase from "../../models/Purchase.modal.js";
import Sale from "../../models/Sale.modal.js";
import { getReturnExchangeAdjustmentRows } from "../../services/reports/getReturnExchangeAdjustments.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { parseLocalDate, defaultMonthRange, localBucketKeyFor } from "../../services/analytics/analyticsDateUtils.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;
// Same locked threshold as Inventory's Slow-moving (LOGIC.md §5.3) -
// Sales' own "Slow-moving Products" is explicitly the same rule,
// applied to product identity here instead of stock ₹ value.
const SLOW_MOVING_DAYS = 60;
const itemQuantity = (item) => (item.isSerialized ? 1 : item.quantity || 0);
const marginPercent = (profit, revenue) => (revenue > 0 ? round2((profit / revenue) * 100) : 0);

export const getSalesAnalyticsController = async (req, res) => {
  try {
    const { branchId, startDate, endDate, granularity = "day" } = req.query;
    const branchObjectId = branchId ? new mongoose.Types.ObjectId(branchId) : null;

    let start, end;
    if (startDate && endDate) {
      start = parseLocalDate(startDate);
      end = parseLocalDate(endDate, true);
    }
    if (!start || !end) {
      const def = defaultMonthRange();
      start = def.start;
      end = def.end;
    }

    const [branches, branch] = await Promise.all([
      Branch.find({ isActive: true, isDeleted: false }).select("_id name code").sort({ name: 1 }).lean(),
      branchObjectId ? Branch.findById(branchObjectId).select("name").lean() : Promise.resolve(null),
    ]);

    const saleBranchMatch = branchObjectId ? { branchId: branchObjectId } : {};
    const saleMatch = { status: "COMPLETED", isDeleted: false, saleDate: { $gte: start, $lte: end }, ...saleBranchMatch };

    // ---- ONE fetch of every period Sale (populated for category/model),
    // reduced many ways in JS below - Top Selling, Slow-moving inverse,
    // Category, Model, Discount, Units Sold, Average Invoice all come
    // from this single pass, mirroring getDashboard.controller.js's
    // getPeriodSections pattern.
    const sales = await Sale.find(saleMatch)
      .populate("items.productId", "category modelNumber isSerialized")
      .select("items totalAmount totalDiscount customerId customerSnapshot saleDate")
      .lean();

    const [adjustmentRows, branchPerformance, newVsReturning, slowMovingProducts] = await Promise.all([
      getReturnExchangeAdjustmentRows({ branchObjectId, start, end }),
      branchObjectId ? Promise.resolve([]) : getBranchPerformance(start, end),
      getNewVsReturningCustomers(sales, start, end),
      getSlowMovingProducts(branchObjectId, SLOW_MOVING_DAYS),
    ]);

    const salesAdjustmentTotal = adjustmentRows.reduce((s, r) => s + r.salesAdjustment, 0);

    let totalRevenue = 0;
    let totalDiscount = 0;
    let totalUnits = 0;
    const productMap = new Map(); // productId -> {name, revenue, profit, qty}
    const categoryMap = new Map();
    const modelMap = new Map();
    const keyFn = localBucketKeyFor(granularity);
    const trendBuckets = new Map(); // date -> {netSales, unitsSold}

    for (const sale of sales) {
      totalRevenue += sale.totalAmount || 0;
      totalDiscount += sale.totalDiscount || 0;

      const trendKey = keyFn(sale.saleDate);
      if (!trendBuckets.has(trendKey)) trendBuckets.set(trendKey, { netSales: 0, unitsSold: 0 });
      const bucket = trendBuckets.get(trendKey);
      bucket.netSales += sale.totalAmount || 0;

      for (const item of sale.items || []) {
        const qty = itemQuantity(item);
        totalUnits += qty;
        bucket.unitsSold += qty;

        const category = item.productId?.category || "Uncategorized";
        if (!categoryMap.has(category)) categoryMap.set(category, { category, revenue: 0, qty: 0 });
        const c = categoryMap.get(category);
        c.revenue += item.finalAmount || 0;
        c.qty += qty;

        if (item.isSerialized && item.productId?.modelNumber) {
          const model = item.productId.modelNumber;
          if (!modelMap.has(model)) modelMap.set(model, { model, revenue: 0, qty: 0 });
          const m = modelMap.get(model);
          m.revenue += item.finalAmount || 0;
          m.qty += qty;
        }

        const pKey = (item.productId?._id || item.productId)?.toString() || item.productName;
        if (!productMap.has(pKey)) {
          productMap.set(pKey, { productId: item.productId?._id || item.productId || null, productName: item.productName || "Unknown Product", revenue: 0, profit: 0, qty: 0, discount: 0 });
        }
        const p = productMap.get(pKey);
        p.revenue += item.finalAmount || 0;
        p.profit += item.profit || 0;
        p.qty += qty;
        p.discount += item.discount || 0;
      }
    }

    const netRevenue = round2(totalRevenue + salesAdjustmentTotal);
    const invoiceCount = sales.length;
    const averageInvoiceValue = invoiceCount > 0 ? round2(totalRevenue / invoiceCount) : 0;

    const topSellingProducts = [...productMap.values()]
      .map((p) => ({ ...p, revenue: round2(p.revenue), profit: round2(p.profit), marginPercent: marginPercent(p.profit, p.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const categoryPerformance = [...categoryMap.values()].map((c) => ({ ...c, revenue: round2(c.revenue) })).sort((a, b) => b.revenue - a.revenue);
    const modelPerformance = [...modelMap.values()].map((m) => ({ ...m, revenue: round2(m.revenue) })).sort((a, b) => b.revenue - a.revenue).slice(0, 10);

    const discountAnalysis = [...productMap.values()]
      .filter((p) => p.discount > 0)
      .map((p) => ({ productId: p.productId, productName: p.productName, discount: round2(p.discount) }))
      .sort((a, b) => b.discount - a.discount)
      .slice(0, 10);

    const trend = [...trendBuckets.entries()]
      .map(([date, v]) => ({ date, netSales: round2(v.netSales), unitsSold: v.unitsSold }))
      .sort((a, b) => a.date.localeCompare(b.date));
    for (const r of adjustmentRows) {
      const key = keyFn(r.date);
      if (!trendBuckets.has(key)) {
        trend.push({ date: key, netSales: round2(r.salesAdjustment), unitsSold: 0 });
      } else {
        const row = trend.find((t) => t.date === key);
        if (row) row.netSales = round2(row.netSales + r.salesAdjustment);
      }
    }
    trend.sort((a, b) => a.date.localeCompare(b.date));

    const payload = {
      period: { startDate: start, endDate: end },
      branch: branch ? { _id: branchObjectId, name: branch.name } : null,
      branches,
      summary: {
        totalSales: round2(totalRevenue),
        netSales: netRevenue,
        unitsSold: totalUnits,
        invoiceCount,
        averageInvoiceValue,
        discountsGiven: round2(totalDiscount),
      },
      topSellingProducts,
      slowMovingProducts,
      categoryPerformance,
      modelPerformance,
      branchPerformance,
      discountAnalysis,
      trend,
      newVsReturning,
    };

    return successResponse(res, "Sales analytics retrieved successfully", payload);
  } catch (error) {
    console.error("Sales Analytics Error:", error);
    return errorResponse(res, error.message || "Failed to load sales analytics", 500);
  }
};

// ============================================================
// Branch Performance - only meaningful across "All Branches" (SUPER_
// ADMIN, no branch filter selected). Mirrors
// getDashboard.controller.js's getBranchComparison (sales/profit/
// purchase per branch), excluding Type 2 Exchange trade-in purchases
// from the purchase figure - same established convention.
// ============================================================
const getBranchPerformance = async (start, end) => {
  const saleMatch = { status: "COMPLETED", isDeleted: false, saleDate: { $gte: start, $lte: end } };
  const purchaseMatch = { status: "COMPLETED", isDeleted: false, source: { $ne: "CUSTOMER_EXCHANGE" }, purchaseDate: { $gte: start, $lte: end } };

  const [sales, purchases, branches] = await Promise.all([
    Sale.find(saleMatch).select("branchId totalAmount totalProfit").lean(),
    Purchase.find(purchaseMatch).select("branchId items.branchId items.totalPrice totalAmount poType").lean(),
    Branch.find({ isActive: true, isDeleted: false }).select("name").lean(),
  ]);

  const byBranch = new Map(branches.map((b) => [b._id.toString(), { branchId: b._id, branchName: b.name, sales: 0, profit: 0, purchase: 0 }]));

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
        if (key && byBranch.has(key)) byBranch.get(key).purchase += item.totalPrice || 0;
      }
    } else {
      const key = p.branchId?.toString();
      if (key && byBranch.has(key)) byBranch.get(key).purchase += p.totalAmount || 0;
    }
  }

  return [...byBranch.values()]
    .map((b) => ({ ...b, sales: round2(b.sales), profit: round2(b.profit), purchase: round2(b.purchase) }))
    .sort((a, b) => b.sales - a.sales);
};

// ============================================================
// New vs Returning Customers - locked decision, LOGIC.md §5.4: a
// customer is "new" (for this period) if their global first-ever
// completed sale falls WITHIN the selected period; otherwise they're
// "returning" (they had at least one sale before the period started).
// No rolling time window.
// ============================================================
const getNewVsReturningCustomers = async (periodSales, start, end) => {
  const customerIds = [...new Set(periodSales.map((s) => s.customerId?.toString()).filter(Boolean))];
  if (customerIds.length === 0) return { newCount: 0, returningCount: 0, newRevenue: 0, returningRevenue: 0 };

  const firstSaleRows = await Sale.aggregate([
    { $match: { status: "COMPLETED", isDeleted: false, customerId: { $in: customerIds.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $group: { _id: "$customerId", firstSaleDate: { $min: "$saleDate" } } },
  ]);
  const firstSaleMap = new Map(firstSaleRows.map((r) => [r._id.toString(), r.firstSaleDate]));

  const newCustomerIds = new Set();
  const returningCustomerIds = new Set();
  let newRevenue = 0;
  let returningRevenue = 0;

  for (const sale of periodSales) {
    const cId = sale.customerId?.toString();
    if (!cId) continue;
    const firstSaleDate = firstSaleMap.get(cId);
    const isNew = firstSaleDate && new Date(firstSaleDate) >= start && new Date(firstSaleDate) <= end;
    if (isNew) {
      newCustomerIds.add(cId);
      newRevenue += sale.totalAmount || 0;
    } else {
      returningCustomerIds.add(cId);
      returningRevenue += sale.totalAmount || 0;
    }
  }

  return {
    newCount: newCustomerIds.size,
    returningCount: returningCustomerIds.size,
    newRevenue: round2(newRevenue),
    returningRevenue: round2(returningRevenue),
  };
};

// ============================================================
// Slow-moving Products (Sales view) - the same 60-day-no-sale rule as
// Inventory's Slow-moving Stock (LOGIC.md §5.3), but listed by product
// identity/quantity here rather than a single aggregate ₹ figure -
// "which specific products aren't moving," a Sales-team question,
// answered from the same underlying facts (current AVAILABLE stock +
// recent Sale activity).
// ============================================================
const getSlowMovingProducts = async (branchObjectId, days) => {
  const cutoff = new Date(Date.now() - days * DAY_MS);

  const serialMatch = { isDeleted: false, status: "AVAILABLE", receivedAt: { $lte: cutoff }, ...(branchObjectId ? { currentBranchId: branchObjectId } : {}) };
  const batchMatch = { status: "ACTIVE", ...(branchObjectId ? { branchId: branchObjectId } : {}) };

  const [slowSerials, activeBatches, recentSaleKeys] = await Promise.all([
    ProductSerial.find(serialMatch).select("productId").lean(),
    BatchStock.find(batchMatch).select("productId branchId availableQuantity").lean(),
    getRecentSaleProductBranchKeys(branchObjectId, days),
  ]);

  const productQty = new Map(); // productId -> qty
  for (const s of slowSerials) {
    const key = s.productId?.toString();
    if (key) productQty.set(key, (productQty.get(key) || 0) + 1);
  }
  for (const b of activeBatches) {
    const key = `${b.productId?.toString()}::${b.branchId?.toString()}`;
    if (!recentSaleKeys.has(key) && b.availableQuantity > 0) {
      const pKey = b.productId?.toString();
      productQty.set(pKey, (productQty.get(pKey) || 0) + b.availableQuantity);
    }
  }

  const productIds = [...productQty.keys()].filter(Boolean);
  const products = productIds.length ? await Product.find({ _id: { $in: productIds } }).select("name").lean() : [];
  const nameMap = new Map(products.map((p) => [p._id.toString(), p.name]));

  return [...productQty.entries()]
    .map(([productId, qty]) => ({ productId, productName: nameMap.get(productId) || "Unknown Product", qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);
};

// Same helper shape as getInventoryAnalytics.controller.js's own copy -
// kept local rather than shared, since each controller's own
// branch/date scoping context around it differs slightly.
const getRecentSaleProductBranchKeys = async (branchObjectId, days) => {
  const cutoff = new Date(Date.now() - days * DAY_MS);
  const match = { status: "COMPLETED", isDeleted: false, saleDate: { $gte: cutoff }, ...(branchObjectId ? { branchId: branchObjectId } : {}) };
  const rows = await Sale.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $match: { "items.isSerialized": false } },
    { $group: { _id: { productId: "$items.productId", branchId: "$branchId" } } },
  ]);
  return new Set(rows.map((r) => `${r._id.productId?.toString()}::${r._id.branchId?.toString()}`));
};
