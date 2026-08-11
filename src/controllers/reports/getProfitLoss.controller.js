// controllers/reports/getProfitLoss.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import Branch from "../../models/Branch.modal.js";
import Product from "../../models/Product.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

/**
 * 📊 PROFIT & LOSS REPORT
 *
 * Every profit figure comes straight from Sale.totalProfit /
 * Sale.totalProfitAfterGst / Sale.items[] - the same real, margin/GST-
 * aware numbers createSale.controller.js already computes and freezes
 * at the moment of each sale (see Sale.modal.js's SALE_FROZEN_FIELDS).
 * This controller never re-derives profit from sellingPrice-
 * purchasePrice; it only aggregates and presents what's already been
 * computed and stored, so a change here can never retroactively alter
 * a historical sale's own numbers.
 *
 * Revenue/Cost/Discount/Profit always reconcile as
 * Revenue - Cost - Discount = Profit, using items.subtotal (pre-GST,
 * pre-discount) as "Revenue" and items.purchasePrice*quantity as
 * "Cost" - matching the waterfall's own grossSales/cogs convention.
 * GST is deliberately a separate, non-reconciling column (see the GST
 * payable section) so it's never mistaken for part of that chain.
 *
 * Only COMPLETED sales are included - DRAFT isn't a real transaction
 * yet, and CANCELLED never happened from a P&L standpoint.
 *
 * 🔍 Query params: startDate, endDate (default: current month),
 * branchId (SUPER_ADMIN only).
 * 👤 Role: SUPER_ADMIN sees all branches or one via branchId;
 * BRANCH_ADMIN is always forced to their own branch (route also blocks
 * STAFF entirely - see reports.router.js).
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const changePercent = (current, previous) => {
  if (!previous) return current > 0 ? 100 : 0;
  return round2(((current - previous) / Math.abs(previous)) * 100);
};

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const weekKey = (d) => {
  const date = new Date(d);
  const firstDayOfWeek = new Date(date);
  firstDayOfWeek.setDate(date.getDate() - date.getDay());
  return firstDayOfWeek.toISOString().slice(0, 10);
};
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

const startOfCurrentMonth = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
};
const endOfToday = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
};

// Waterfall totals for one date range - the single source both the
// "current period" and "previous period" figures are computed from, so
// the two can never be accidentally computed differently.
const getWaterfallTotals = async (match) => {
  const [agg] = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        grossSales: { $sum: "$subtotalAmount" },
        discounts: { $sum: "$totalDiscount" },
        gstCollected: { $sum: "$totalGstAmount" },
        grossProfit: { $sum: "$totalProfit" },
        netProfit: { $sum: "$totalProfitAfterGst" },
        totalAmount: { $sum: "$totalAmount" },
        salesCount: { $sum: 1 },
      },
    },
  ]);

  const grossSales = agg?.grossSales || 0;
  const discounts = agg?.discounts || 0;
  const netRevenue = round2(grossSales - discounts);
  const grossProfit = round2(agg?.grossProfit || 0);
  const netProfit = round2(agg?.netProfit || 0);
  const cogs = round2(netRevenue - grossProfit);

  return {
    grossSales: round2(grossSales),
    discounts: round2(discounts),
    netRevenue,
    cogs,
    grossProfit,
    gstCollected: round2(agg?.gstCollected || 0),
    netProfit,
    salesCount: agg?.salesCount || 0,
    totalAmount: round2(agg?.totalAmount || 0),
    grossMarginPercent: netRevenue > 0 ? round2((grossProfit / netRevenue) * 100) : 0,
    netMarginPercent: netRevenue > 0 ? round2((netProfit / netRevenue) * 100) : 0,
  };
};

const withComparison = (currentWaterfall, previousWaterfall) => {
  const result = {};
  for (const key of ["grossSales", "discounts", "netRevenue", "cogs", "grossProfit", "gstCollected", "netProfit"]) {
    result[key] = {
      value: currentWaterfall[key],
      previousValue: previousWaterfall[key],
      changePercent: changePercent(currentWaterfall[key], previousWaterfall[key]),
    };
  }
  result.grossMarginPercent = currentWaterfall.grossMarginPercent;
  result.netMarginPercent = currentWaterfall.netMarginPercent;
  result.previousGrossMarginPercent = previousWaterfall.grossMarginPercent;
  result.previousNetMarginPercent = previousWaterfall.netMarginPercent;
  return result;
};

// All three granularities computed from one query, so the frontend's
// daily/weekly/monthly toggle is instant (client-side) instead of
// re-fetching per click.
const getTrend = async (match) => {
  const sales = await Sale.find(match).select("saleDate subtotalAmount totalDiscount totalProfit totalProfitAfterGst").lean();

  const buildBuckets = (keyFn) => {
    const buckets = new Map();
    for (const s of sales) {
      const key = keyFn(s.saleDate);
      if (!buckets.has(key)) buckets.set(key, { period: key, netRevenue: 0, grossProfit: 0, netProfit: 0 });
      const bucket = buckets.get(key);
      bucket.netRevenue += (s.subtotalAmount || 0) - (s.totalDiscount || 0);
      bucket.grossProfit += s.totalProfit || 0;
      bucket.netProfit += s.totalProfitAfterGst || 0;
    }
    return Array.from(buckets.values())
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((b) => ({
        period: b.period,
        netRevenue: round2(b.netRevenue),
        cogs: round2(b.netRevenue - b.grossProfit),
        grossProfit: round2(b.grossProfit),
        netProfit: round2(b.netProfit),
      }));
  };

  return {
    daily: buildBuckets(dayKey),
    weekly: buildBuckets(weekKey),
    monthly: buildBuckets(monthKey),
  };
};

const getCategoryBreakdown = async (match) => {
  const rows = await Sale.aggregate([
    { $match: match },
    { $unwind: "$items" },
    {
      $lookup: {
        from: "products",
        localField: "items.productId",
        foreignField: "_id",
        as: "product",
      },
    },
    {
      $group: {
        _id: { $ifNull: [{ $arrayElemAt: ["$product.category", 0] }, "UNCATEGORIZED"] },
        revenue: { $sum: "$items.finalAmount" },
        profit: { $sum: "$items.profit" },
        quantity: { $sum: { $ifNull: ["$items.quantity", 1] } },
      },
    },
    { $sort: { revenue: -1 } },
  ]);

  return rows.map((r) => ({
    category: r._id,
    revenue: round2(r.revenue),
    profit: round2(r.profit),
    quantity: r.quantity,
  }));
};

const getBranchComparison = async (match) => {
  const rows = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$branchId",
        netRevenue: { $sum: { $subtract: ["$subtotalAmount", "$totalDiscount"] } },
        grossProfit: { $sum: "$totalProfit" },
        netProfit: { $sum: "$totalProfitAfterGst" },
      },
    },
    {
      $lookup: { from: "branches", localField: "_id", foreignField: "_id", as: "branch" },
    },
    { $sort: { netRevenue: -1 } },
  ]);

  return rows.map((r) => ({
    branchId: r._id,
    branchName: r.branch?.[0]?.name || "Unknown Branch",
    netRevenue: round2(r.netRevenue),
    cogs: round2(r.netRevenue - r.grossProfit),
    grossProfit: round2(r.grossProfit),
    netProfit: round2(r.netProfit),
  }));
};

// Serialized: one row per PHYSICAL UNIT sold (never grouped/collapsed
// by product) - each unit has its own serial number, its own purchase
// cost, and can legitimately differ from every other unit of the same
// model. inputGstAmount comes straight from that exact unit's own
// ProductSerial.purchaseGstAmount (frozen at purchase time) - most
// second-hand units will show 0 here (no input tax paid), but a unit
// genuinely bought from a GST-registered dealer carries a real value.
const getSerializedUnitPL = async (match) => {
  const rows = await Sale.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $match: { "items.isSerialized": true } },
    {
      $lookup: {
        from: "products",
        localField: "items.productId",
        foreignField: "_id",
        as: "product",
      },
    },
    {
      $lookup: {
        from: "productserials",
        localField: "items.productSerialId",
        foreignField: "_id",
        as: "serial",
      },
    },
    {
      $project: {
        _id: 0,
        saleId: "$_id",
        saleNumber: 1,
        saleDate: 1,
        productId: "$items.productId",
        productName: "$items.productName",
        productCode: "$items.productCode",
        modelNumber: "$items.modelNumber",
        serialNumber: "$items.serialNumber",
        category: { $ifNull: [{ $arrayElemAt: ["$product.category", 0] }, "UNCATEGORIZED"] },
        purchasePrice: "$items.purchasePrice",
        sellingPrice: "$items.sellingPrice",
        discount: "$items.discount",
        gstApplicable: "$items.gstApplicable",
        gstPercent: "$items.gstPercent",
        gstAmount: "$items.gstAmount",
        profit: "$items.profit",
        inputGstAmount: { $ifNull: [{ $arrayElemAt: ["$serial.purchaseGstAmount", 0] }, 0] },
      },
    },
    { $sort: { profit: -1 } },
  ]);

  return rows.map((r) => ({
    saleId: r.saleId,
    saleNumber: r.saleNumber,
    saleDate: r.saleDate,
    productId: r.productId,
    productName: r.productName || "Unknown Product",
    productCode: r.productCode || "",
    modelNumber: r.modelNumber || "",
    serialNumber: r.serialNumber || "",
    category: r.category,
    purchasePrice: round2(r.purchasePrice || 0),
    sellingPrice: round2(r.sellingPrice || 0),
    discount: round2(r.discount || 0),
    gstApplicable: !!r.gstApplicable,
    gstPercent: r.gstPercent || 0,
    gstAmount: round2(r.gstAmount || 0),
    inputGstAmount: round2(r.inputGstAmount || 0),
    // Output GST minus input tax credit already paid on this unit at
    // purchase time - the real amount attributable to the government
    // for this specific sale, never just the output figure alone.
    netGstPayable: round2((r.gstAmount || 0) - (r.inputGstAmount || 0)),
    profit: round2(r.profit || 0),
    marginPercent: r.sellingPrice > 0 ? round2((r.profit / r.sellingPrice) * 100) : 0,
  }));
};

// Non-serialized: real inventory is tracked per-batch (different
// batches of the same product can carry different purchase costs), so
// each batch gets its own P&L row rather than collapsing every batch of
// a product together. inputGstAmount needs no lookup - the output rate
// on a non-serialized sale IS the purchase-time rate carried through
// unchanged (createSale.controller.js's non-serialized branch never
// re-derives it), so it's computable straight from the sale item's own
// purchasePrice/quantity/gstPercent.
const getNonSerializedBatchPL = async (match) => {
  const rows = await Sale.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $match: { "items.isSerialized": false } },
    {
      $group: {
        _id: { productId: "$items.productId", batchNumber: "$items.batchNumber" },
        productName: { $first: "$items.productName" },
        productCode: { $first: "$items.productCode" },
        quantitySold: { $sum: { $ifNull: ["$items.quantity", 0] } },
        revenue: { $sum: "$items.subtotal" },
        cost: { $sum: { $multiply: ["$items.purchasePrice", { $ifNull: ["$items.quantity", 0] }] } },
        discount: { $sum: "$items.discount" },
        gstAmount: { $sum: "$items.gstAmount" },
        inputGstAmount: {
          $sum: {
            $divide: [
              { $multiply: ["$items.purchasePrice", { $ifNull: ["$items.quantity", 0] }, "$items.gstPercent"] },
              100,
            ],
          },
        },
        profit: { $sum: "$items.profit" },
      },
    },
    { $sort: { profit: -1 } },
  ]);

  return rows.map((r) => ({
    productId: r._id.productId,
    productName: r.productName || "Unknown Product",
    productCode: r.productCode || "",
    batchNumber: r._id.batchNumber || "—",
    quantitySold: r.quantitySold,
    purchaseRate: r.quantitySold > 0 ? round2(r.cost / r.quantitySold) : 0,
    saleRate: r.quantitySold > 0 ? round2(r.revenue / r.quantitySold) : 0,
    revenue: round2(r.revenue),
    cogs: round2(r.cost),
    discount: round2(r.discount),
    gstAmount: round2(r.gstAmount),
    inputGstAmount: round2(r.inputGstAmount),
    netGstPayable: round2(r.gstAmount - r.inputGstAmount),
    profit: round2(r.profit),
    marginPercent: r.revenue > 0 ? round2((r.profit / r.revenue) * 100) : 0,
  }));
};

// Output GST reuses the exact figure the waterfall's "GST Collected"
// line already sums (Sale.totalGstAmount) - never a second,
// independently-computed source. Input GST credit is tax already paid
// upstream at purchase time, attributable to the units actually sold in
// this period. Net payable = output - input, which is the real amount
// owed to the government (standard GST/VAT input-credit mechanics, not
// a simplification) - not just gross GST collected from customers.
const getGstPayableSummary = async (match, outputGst) => {
  const [nonSerializedAgg] = await Sale.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $match: { "items.isSerialized": false } },
    {
      $group: {
        _id: null,
        inputGst: {
          $sum: {
            $divide: [
              { $multiply: ["$items.purchasePrice", { $ifNull: ["$items.quantity", 0] }, "$items.gstPercent"] },
              100,
            ],
          },
        },
      },
    },
  ]);

  const [serializedAgg] = await Sale.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $match: { "items.isSerialized": true } },
    {
      $lookup: {
        from: "productserials",
        localField: "items.productSerialId",
        foreignField: "_id",
        as: "serial",
      },
    },
    {
      $group: {
        _id: null,
        inputGst: { $sum: { $ifNull: [{ $arrayElemAt: ["$serial.purchaseGstAmount", 0] }, 0] } },
      },
    },
  ]);

  const rateBreakdownRows = await Sale.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $match: { "items.gstAmount": { $gt: 0 } } },
    {
      $group: {
        _id: "$items.gstPercent",
        amount: { $sum: "$items.gstAmount" },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const inputGstCredit = round2((nonSerializedAgg?.inputGst || 0) + (serializedAgg?.inputGst || 0));

  return {
    outputGst: round2(outputGst),
    inputGstCredit,
    netPayable: round2(outputGst - inputGstCredit),
    rateBreakdown: rateBreakdownRows.map((r) => ({ rate: r._id || 0, amount: round2(r.amount) })),
  };
};

// One combined per-product ranking across BOTH serialized and
// non-serialized sales (every batch/unit of a product collapsed into
// one row) - purely for the "most profitable products" highlight list,
// distinct from the per-unit/per-batch tables above which intentionally
// keep every row separate.
const getProductRanking = async (match) => {
  const rows = await Sale.aggregate([
    { $match: match },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.productId",
        productName: { $first: "$items.productName" },
        isSerialized: { $first: "$items.isSerialized" },
        revenue: { $sum: "$items.subtotal" },
        profit: { $sum: "$items.profit" },
      },
    },
    { $sort: { profit: -1 } },
  ]);

  const ranked = rows.map((r) => ({
    productId: r._id,
    productName: r.productName || "Unknown Product",
    type: r.isSerialized ? "Serialized" : "Batch",
    profit: round2(r.profit),
    marginPercent: r.revenue > 0 ? round2((r.profit / r.revenue) * 100) : 0,
  }));

  const topProfitable = ranked.slice(0, 8);
  const highestProfit = ranked.length > 0 ? ranked[0] : null;
  const byMargin = [...ranked].sort((a, b) => b.marginPercent - a.marginPercent);
  const highestMargin = byMargin.length > 0 ? byMargin[0] : null;
  const lowestMargin = byMargin.length > 0 ? byMargin[byMargin.length - 1] : null;
  const lossMakers = ranked.filter((r) => r.profit < 0).sort((a, b) => a.profit - b.profit);
  const lossMaking = lossMakers.length > 0 ? lossMakers[0] : null;

  return { topProfitable, highlights: { highestProfit, highestMargin, lowestMargin, lossMaking } };
};

export const getProfitLossController = async (req, res) => {
  try {
    const user = req.user;
    const isSuperAdmin = user.role === "SUPER_ADMIN";
    const { startDate, endDate, branchId } = req.query;

    // ============================================================
    // DATE RANGE - defaults to current month, inclusive of both ends.
    // ============================================================
    const start = startDate ? new Date(startDate) : startOfCurrentMonth();
    start.setHours(0, 0, 0, 0);
    const end = endDate ? new Date(endDate) : endOfToday();
    end.setHours(23, 59, 59, 999);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return errorResponse(res, "Invalid date range", 400);
    }

    // Previous period of equal length, immediately preceding the
    // current one - the comparison baseline for every "% change" figure.
    const rangeMs = end.getTime() - start.getTime();
    const previousEnd = new Date(start.getTime() - 1);
    const previousStart = new Date(previousEnd.getTime() - rangeMs);

    // ============================================================
    // BRANCH SCOPING - same convention as getDashboard.controller.js.
    // ============================================================
    let branchObjectId = null;
    if (isSuperAdmin && branchId) {
      branchObjectId = new mongoose.Types.ObjectId(branchId);
    } else if (!isSuperAdmin) {
      if (!user.branchId) return errorResponse(res, "Branch not assigned to user", 400);
      branchObjectId = new mongoose.Types.ObjectId(user.branchId);
    }

    let branchInfo = null;
    if (branchObjectId) {
      const branch = await Branch.findById(branchObjectId).select("name code").lean();
      branchInfo = branch ? { id: branch._id, name: branch.name, code: branch.code } : null;
    }

    let branches = [];
    if (isSuperAdmin) {
      branches = await Branch.find({ isActive: true, isDeleted: false }).select("_id name code").sort({ name: 1 }).lean();
    }

    const baseMatch = { isDeleted: false, status: "COMPLETED" };
    if (branchObjectId) baseMatch.branchId = branchObjectId;

    const currentMatch = { ...baseMatch, saleDate: { $gte: start, $lte: end } };
    const previousMatch = { ...baseMatch, saleDate: { $gte: previousStart, $lte: previousEnd } };

    // ============================================================
    // RUN EVERYTHING IN PARALLEL
    // ============================================================
    const [
      currentWaterfall,
      previousWaterfall,
      trend,
      categoryBreakdown,
      branchComparison,
      serializedUnitPL,
      nonSerializedBatchPL,
      productRanking,
    ] = await Promise.all([
      getWaterfallTotals(currentMatch),
      getWaterfallTotals(previousMatch),
      getTrend(currentMatch),
      getCategoryBreakdown(currentMatch),
      // Branch comparison only makes sense when not already scoped to
      // one branch (SUPER_ADMIN viewing "All Branches").
      isSuperAdmin && !branchObjectId ? getBranchComparison(currentMatch) : Promise.resolve([]),
      getSerializedUnitPL(currentMatch),
      getNonSerializedBatchPL(currentMatch),
      getProductRanking(currentMatch),
    ]);

    const waterfall = withComparison(currentWaterfall, previousWaterfall);
    const gstPayable = await getGstPayableSummary(currentMatch, currentWaterfall.gstCollected);

    const totalItemsSold = categoryBreakdown.reduce((sum, c) => sum + c.quantity, 0);

    return successResponse(res, "Profit & Loss report retrieved successfully", {
      period: { startDate: start, endDate: end },
      previousPeriod: { startDate: previousStart, endDate: previousEnd },
      branch: branchInfo,
      branches,
      waterfall,
      trend,
      categoryBreakdown,
      branchComparison,
      serializedUnitPL,
      nonSerializedBatchPL,
      gstPayable,
      productRanking,
      summary: {
        totalSales: currentWaterfall.salesCount,
        totalItemsSold,
        avgOrderValue: currentWaterfall.salesCount > 0 ? round2(currentWaterfall.netRevenue / currentWaterfall.salesCount) : 0,
        avgMarginPercent: currentWaterfall.grossMarginPercent,
      },
    });
  } catch (error) {
    console.error("Get Profit & Loss Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve profit & loss report", 500);
  }
};
