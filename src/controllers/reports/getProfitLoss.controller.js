// controllers/reports/getProfitLoss.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import Branch from "../../models/Branch.modal.js";
import { getReturnExchangeAdjustments } from "../../services/reports/getReturnExchangeAdjustments.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

/**
 * 📊 PROFIT & LOSS REPORT (owner-friendly 5-step waterfall)
 *
 * Sales -> Product Cost -> Profit Before Tax -> GST/Tax -> Final Profit.
 * Every figure comes straight from fields already frozen on Sale /
 * Sale.items[] at the moment of each sale (see Sale.modal.js) - this
 * controller never re-derives profit from sellingPrice-purchasePrice,
 * so a change here can never retroactively alter a historical sale's
 * own numbers, and it can never diverge from what createSale.controller.js
 * actually computed.
 *
 * GST/Tax is a real, period-level net figure: output GST collected from
 * customers (Sale.totalGstAmount) minus input GST credit already paid
 * upstream at purchase time (Sale.totalPurchaseGstAmount, non-serialized
 * only - serialized/second-hand sales never carry an input credit under
 * the margin scheme). Input GST credit is pooled per period, not traced
 * per sale-item, matching how real ITC accounting works - so it's
 * computed once at the aggregate level here, never per-line.
 *
 * Sales and Product Cost are deliberately GST-INCLUSIVE (actual cash in/
 * cash out), so Profit Before Tax minus GST/Tax always reconciles to the
 * same real profit already frozen on every sale (Sale.totalProfit) - see
 * getWaterfallTotals's own comment for the full worked-out reasoning.
 *
 * Only COMPLETED sales are included - DRAFT isn't a real transaction
 * yet, and CANCELLED never happened from a P&L standpoint.
 *
 * 🔍 Query params: startDate, endDate (default: current month),
 * branchId (SUPER_ADMIN only).
 * 👤 Role: any authenticated role can call this. SUPER_ADMIN sees all
 * branches or one via branchId; BRANCH_ADMIN and STAFF are always
 * forced to their own branch.
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
//
// "Sales" and "Product Cost" are deliberately GST-INCLUSIVE (the actual
// cash that changed hands): Sales = Sale.totalAmount (what the customer
// paid - for a non-serialized item that's base+output GST; for a
// serialized/margin-scheme item GST is never added on top, so it's just
// the base price, matching how finalAmount is built per type in
// createSale.controller.js). Product Cost mirrors this on the purchase
// side: base cost plus whatever input GST was actually paid to the
// vendor at purchase time (Sale.totalPurchaseGstAmount - always 0 for
// serialized units, since second-hand purchases never carry input GST).
// GST/Tax is the separate, real remittance owed to the government this
// period (output collected minus input credit). Subtracting it from
// this GST-inclusive "Profit Before Tax" is what makes Final Profit land
// exactly on the same number as summing every item's own true profit
// (Sale.totalProfit) - GST is a pass-through by construction, so this
// isn't a coincidence, it's the whole point of doing the math this way
// instead of just re-displaying totalProfit directly: the waterfall
// shows the OWNER where the government's cut actually comes out of,
// while still reconciling to the one true profit figure.
// `adjustments` folds in the real economic effect of any Return/Exchange
// in this same period (see getReturnExchangeAdjustments.js) into the
// four RAW base figures (sales/baseCost/gstCollected/inputGstCredit) -
// never into profitBeforeTax/gstTax/finalProfit directly. Those three
// stay fully DERIVED from the (now-adjusted) base figures via this
// function's own existing formula below, so the "GST is a pass-through
// by construction" reconciliation this file's top comment describes
// keeps holding exactly, adjusted or not - it's the same math, just
// fed slightly different inputs.
const getWaterfallTotals = async (match, adjustments = null) => {
  const [agg] = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        baseSales: { $sum: { $subtract: ["$subtotalAmount", "$totalDiscount"] } },
        grossSales: { $sum: "$totalAmount" },
        gstCollected: { $sum: "$totalGstAmount" },
        inputGstCredit: { $sum: "$totalPurchaseGstAmount" },
        baseProfit: { $sum: "$totalProfit" },
        salesCount: { $sum: 1 },
      },
    },
  ]);

  const adj = adjustments || { salesAdjustment: 0, costAdjustment: 0, gstAdjustment: 0, purchaseGstAdjustment: 0 };

  const baseSales = agg?.baseSales || 0;
  const baseProfit = round2(agg?.baseProfit || 0);
  const baseCost = round2(baseSales - baseProfit) + adj.costAdjustment;
  const gstCollected = round2(agg?.gstCollected || 0) + adj.gstAdjustment;
  const inputGstCredit = round2(agg?.inputGstCredit || 0) + adj.purchaseGstAdjustment;

  const sales = round2(agg?.grossSales || 0) + adj.salesAdjustment;
  // Base cost plus the input GST actually paid at purchase time - see
  // the function comment for why this (not the base-only cost) is the
  // right counterpart to "sales" above.
  const productCost = round2(baseCost + inputGstCredit);
  const profitBeforeTax = round2(sales - productCost);
  // Net GST payable for the period - output collected from customers
  // minus input credit already paid upstream. Can be negative if a
  // period's input credit outweighs its output (e.g. heavy restocking,
  // light selling) - that's a real refundable position, not an error.
  const gstTax = round2(gstCollected - inputGstCredit);
  const finalProfit = round2(profitBeforeTax - gstTax);

  return {
    sales,
    productCost,
    profitBeforeTax,
    gstCollected,
    inputGstCredit,
    gstTax,
    finalProfit,
    salesCount: agg?.salesCount || 0,
    profitBeforeTaxMarginPercent: sales > 0 ? round2((profitBeforeTax / sales) * 100) : 0,
    finalProfitMarginPercent: sales > 0 ? round2((finalProfit / sales) * 100) : 0,
  };
};

const withComparison = (current, previous) => {
  const result = {};
  for (const key of ["sales", "productCost", "profitBeforeTax", "gstTax", "finalProfit"]) {
    result[key] = {
      value: current[key],
      previousValue: previous[key],
      changePercent: changePercent(current[key], previous[key]),
    };
  }
  result.profitBeforeTaxMarginPercent = current.profitBeforeTaxMarginPercent;
  result.finalProfitMarginPercent = current.finalProfitMarginPercent;
  result.previousProfitBeforeTaxMarginPercent = previous.profitBeforeTaxMarginPercent;
  result.previousFinalProfitMarginPercent = previous.finalProfitMarginPercent;
  return result;
};

// All three granularities computed from one query, so the frontend's
// daily/weekly/monthly toggle is instant (client-side) instead of
// re-fetching per click. Bucketed straight off document-level totals
// (no item-level unwind) - same gross-Sales/gross-Cost math as
// getWaterfallTotals (see its comment for why), just grouped by
// day/week/month instead of the whole period.
const getTrend = async (match, adjustmentsDaily = []) => {
  const sales = await Sale.find(match)
    .select("saleDate subtotalAmount totalDiscount totalProfit totalGstAmount totalPurchaseGstAmount totalAmount")
    .lean();

  const emptyBucket = (key) => ({ period: key, baseSales: 0, grossSales: 0, baseProfit: 0, gstCollected: 0, inputGstCredit: 0, salesAdj: 0, costAdj: 0, gstAdj: 0, purchaseGstAdj: 0 });

  const buildBuckets = (keyFn) => {
    const buckets = new Map();
    for (const s of sales) {
      const key = keyFn(s.saleDate);
      if (!buckets.has(key)) buckets.set(key, emptyBucket(key));
      const bucket = buckets.get(key);
      bucket.baseSales += (s.subtotalAmount || 0) - (s.totalDiscount || 0);
      bucket.grossSales += s.totalAmount || 0;
      bucket.baseProfit += s.totalProfit || 0;
      bucket.gstCollected += s.totalGstAmount || 0;
      bucket.inputGstCredit += s.totalPurchaseGstAmount || 0;
    }
    // Return/Exchange adjustments come pre-bucketed by day (see
    // getReturnExchangeAdjustments.js) - re-keyed here to whichever
    // granularity this pass is building (day/week/month all parse the
    // "YYYY-MM-DD" date string the same way the Sale-side keyFn does).
    for (const a of adjustmentsDaily) {
      const key = keyFn(a.date);
      if (!buckets.has(key)) buckets.set(key, emptyBucket(key));
      const bucket = buckets.get(key);
      bucket.salesAdj += a.salesAdjustment;
      bucket.costAdj += a.costAdjustment;
      bucket.gstAdj += a.gstAdjustment;
      bucket.purchaseGstAdj += a.purchaseGstAdjustment;
    }
    return Array.from(buckets.values())
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((b) => {
        // Same composition as getWaterfallTotals - adjustments fold
        // into the raw base figures, profitBeforeTax/gstTax/finalProfit
        // stay fully derived from them via the unchanged formula below.
        const baseCost = (b.baseSales - b.baseProfit) + b.costAdj;
        const sales = round2(b.grossSales + b.salesAdj);
        const gstCollected = round2(b.gstCollected + b.gstAdj);
        const inputGstCredit = round2(b.inputGstCredit + b.purchaseGstAdj);
        const productCost = round2(baseCost + inputGstCredit);
        const profitBeforeTax = round2(sales - productCost);
        const gstTax = round2(gstCollected - inputGstCredit);
        return {
          period: b.period,
          sales,
          productCost,
          profitBeforeTax,
          gstTax,
          finalProfit: round2(profitBeforeTax - gstTax),
        };
      });
  };

  return {
    daily: buildBuckets(dayKey),
    weekly: buildBuckets(weekKey),
    monthly: buildBuckets(monthKey),
  };
};

// Serialized: one row per PHYSICAL UNIT sold (never grouped/collapsed
// by product) - each unit has its own serial number, its own purchase
// cost, and can legitimately differ from every other unit of the same
// model. inputGstAmount is always 0 (no lookup needed) - a second-hand
// unit sold under the margin scheme never carries an input GST/ITC
// value; createSale.controller.js's serialized branch stamps this
// explicitly at sale time.
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
    inputGstAmount: 0,
    netGstPayable: round2(r.gstAmount || 0),
    profit: round2(r.profit || 0),
    marginPercent: r.sellingPrice > 0 ? round2((r.profit / r.sellingPrice) * 100) : 0,
  }));
};

// Non-serialized: real inventory is tracked per-batch (different
// batches of the same product can carry different purchase costs), so
// each batch gets its own P&L row rather than collapsing every batch of
// a product together. inputGstAmount sums items.purchaseGstAmount - the
// batch's own real, frozen purchase-time input rate (captured by
// createSale.controller.js at sale time) - never re-derived from
// items.gstPercent, which is the sale's OUTPUT rate and can legitimately
// differ from the input rate if the standard GST rate changed between
// that batch's purchase and its sale. Sales made before this field
// existed default to 0 here (same effective behavior as before, not a
// regression - see Sale.modal.js's migration note).
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
        inputGstAmount: { $sum: { $ifNull: ["$items.purchaseGstAmount", 0] } },
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

// Simple owner-facing GST summary: Used Product Tax (serialized output,
// margin-scheme) / New Product GST (non-serialized output) / Purchase
// Tax Credit (input, non-serialized only) / Total (net payable).
// usedProductTax/newProductGst are summed straight from the already-
// fetched serializedUnitPL/nonSerializedBatchPL rows - no extra query.
// outputGst/inputGstCredit are passed in from the same document-level
// sums getWaterfallTotals already computed, so this always reconciles
// exactly with the waterfall's own GST/Tax step. Only the rate breakdown
// (for the "view details" modal) needs its own query.
const getGstPayableSummary = async (match, { outputGst, inputGstCredit, serializedRows, nonSerializedRows }) => {
  const usedProductTax = round2(serializedRows.reduce((sum, r) => sum + (r.gstAmount || 0), 0));
  const newProductGst = round2(nonSerializedRows.reduce((sum, r) => sum + (r.gstAmount || 0), 0));

  const rateBreakdownRows = await Sale.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $match: { "items.gstAmount": { $gt: 0 } } },
    { $group: { _id: "$items.gstPercent", amount: { $sum: "$items.gstAmount" } } },
    { $sort: { _id: 1 } },
  ]);

  return {
    usedProductTax,
    newProductGst,
    outputGst: round2(outputGst),
    purchaseTaxCredit: round2(inputGstCredit),
    netPayable: round2(outputGst - inputGstCredit),
    rateBreakdown: rateBreakdownRows.map((r) => ({ rate: r._id || 0, amount: round2(r.amount) })),
  };
};

// Serialized-vs-non-serialized comparison - built entirely from the
// already-fetched per-unit/per-batch rows (JS reduce), no extra query.
const buildTypeComparison = (serializedRows, nonSerializedRows) => {
  const serializedTotals = serializedRows.reduce(
    (acc, r) => {
      acc.unitsSold += 1;
      acc.revenue += r.sellingPrice - r.discount;
      acc.cost += r.purchasePrice;
      acc.profit += r.profit;
      return acc;
    },
    { unitsSold: 0, revenue: 0, cost: 0, profit: 0 }
  );

  const nonSerializedTotals = nonSerializedRows.reduce(
    (acc, r) => {
      acc.unitsSold += r.quantitySold || 0;
      acc.revenue += r.revenue;
      acc.cost += r.cogs;
      acc.profit += r.profit;
      return acc;
    },
    { unitsSold: 0, revenue: 0, cost: 0, profit: 0 }
  );

  const finalize = (t) => ({
    unitsSold: t.unitsSold,
    revenue: round2(t.revenue),
    cost: round2(t.cost),
    profit: round2(t.profit),
    marginPercent: t.revenue > 0 ? round2((t.profit / t.revenue) * 100) : 0,
  });

  return { serialized: finalize(serializedTotals), nonSerialized: finalize(nonSerializedTotals) };
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
    // RETURN/EXCHANGE ADJUSTMENTS - fetched once per period (current +
    // previous, matching how the waterfall itself already runs twice
    // for the % change comparison), then folded into both the waterfall
    // totals and the trend buckets below. See getReturnExchangeAdjustments.js
    // for the full financial model.
    // ============================================================
    const [currentAdjustments, previousAdjustments] = await Promise.all([
      getReturnExchangeAdjustments({ branchObjectId, start, end }),
      getReturnExchangeAdjustments({ branchObjectId, start: previousStart, end: previousEnd }),
    ]);

    // ============================================================
    // RUN EVERYTHING IN PARALLEL
    // ============================================================
    const [currentWaterfallTotals, previousWaterfallTotals, trend, serializedUnitPL, nonSerializedBatchPL] = await Promise.all([
      getWaterfallTotals(currentMatch, currentAdjustments),
      getWaterfallTotals(previousMatch, previousAdjustments),
      getTrend(currentMatch, currentAdjustments.daily),
      getSerializedUnitPL(currentMatch),
      getNonSerializedBatchPL(currentMatch),
    ]);

    const waterfall = withComparison(currentWaterfallTotals, previousWaterfallTotals);

    const gstPayable = await getGstPayableSummary(currentMatch, {
      outputGst: currentWaterfallTotals.gstCollected,
      inputGstCredit: currentWaterfallTotals.inputGstCredit,
      serializedRows: serializedUnitPL,
      nonSerializedRows: nonSerializedBatchPL,
    });

    const typeComparison = buildTypeComparison(serializedUnitPL, nonSerializedBatchPL);

    const totalItemsSold = serializedUnitPL.length + nonSerializedBatchPL.reduce((sum, r) => sum + (r.quantitySold || 0), 0);

    return successResponse(res, "Profit & Loss report retrieved successfully", {
      period: { startDate: start, endDate: end },
      previousPeriod: { startDate: previousStart, endDate: previousEnd },
      branch: branchInfo,
      branches,
      waterfall,
      trend,
      typeComparison,
      serializedUnitPL,
      nonSerializedBatchPL,
      gstPayable,
      summary: {
        totalSales: currentWaterfallTotals.salesCount,
        totalItemsSold,
        avgOrderValue: currentWaterfallTotals.salesCount > 0 ? round2(currentWaterfallTotals.sales / currentWaterfallTotals.salesCount) : 0,
        avgMarginPercent: currentWaterfallTotals.finalProfitMarginPercent,
      },
    });
  } catch (error) {
    console.error("Get Profit & Loss Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve profit & loss report", 500);
  }
};
