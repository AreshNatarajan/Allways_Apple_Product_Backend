// controllers/analytics/getMoneyAnalytics.controller.js
//
// GET /api/analytics/money - Pillar 1 (Money) of the Business Analytics
// module. Every formula's plain-English definition and the business
// decisions locked in for Net Transaction Value / Profit Margin
// denominator live in
// shopping-frontend/docs/COMPLETE-ANALYTICS-IMPLEMENTATION-LOGIC.md -
// this controller is that document's §2 implemented, nothing more.
//
// Route is SUPER_ADMIN-only (onlySuperAdmin middleware, see
// analytics.router.js) - every figure here is financial, so unlike the
// main Dashboard there is no profit-field-stripping branch for other
// roles: the whole endpoint is simply unreachable by them.
//
// Nothing here re-derives a number the app already computes - it reuses
// Sale/Purchase's own frozen totals and the existing
// getReturnExchangeAdjustmentRows() service (the one place Return/
// Exchange financial impact is modeled), exactly as the main Dashboard
// and P&L report already do. See getReturnExchangeAdjustments.js's own
// header comment for the full Return/Exchange financial model.
//
// Date boundaries are LOCAL time throughout (see analyticsDateUtils.js).

import mongoose from "mongoose";
import Branch from "../../models/Branch.modal.js";
import Sale from "../../models/Sale.modal.js";
import Purchase from "../../models/Purchase.modal.js";
import SaleReturn from "../../models/SaleReturn.modal.js";
import SaleExchange from "../../models/SaleExchange.modal.js";
import SaleTradeIn from "../../models/SaleTradeIn.modal.js";
import { getReturnExchangeAdjustmentRows, sumAdjustmentRows } from "../../services/reports/getReturnExchangeAdjustments.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { parseLocalDate, defaultMonthRange, localBucketKeyFor } from "../../services/analytics/analyticsDateUtils.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Purchase can be a CENTRAL purchase split across branches via per-item
// branchId, or a plain single-branch (BRANCH) purchase - same pattern
// already proven in getDashboard.controller.js/getAllPurchases.controller.js.
// Used only for Vendor Payable below, where pendingAmount is inherently
// a whole-purchase figure that can't be meaningfully split per branch.
const purchaseBranchCondition = (id) => ({ $or: [{ branchId: id }, { "items.branchId": id }] });

export const getMoneyAnalyticsController = async (req, res) => {
  try {
    const { branchId, startDate, endDate, granularity = "day" } = req.query;

    // Route is already onlySuperAdmin-gated - branchId here is purely an
    // optional "view one branch instead of all" filter, never forced.
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

    const adjustmentRows = await getReturnExchangeAdjustmentRows({ branchObjectId, start, end });
    const adjustments = sumAdjustmentRows(adjustmentRows);

    const [
      salesTotals,
      totalPurchases,
      returnsValue,
      returnRefunds,
      exchangeRefunds,
      tradeInRefunds,
      outstandingCustomer,
      vendorPayable,
      collectionByMethod,
      revenueTrend,
    ] = await Promise.all([
      getSalesTotals(saleMatch),
      getTotalPurchases(branchObjectId, start, end),
      getReturnsValue(branchObjectId, start, end),
      getReturnRefunds(branchObjectId, start, end),
      getExchangeRefunds(branchObjectId, start, end),
      getTradeInRefunds(branchObjectId, start, end),
      getOutstandingCustomerPayments(branchObjectId),
      getVendorPayable(branchObjectId),
      getCollectionByMethod(branchObjectId, start, end),
      getRevenueTrend(saleBranchMatch, adjustmentRows, start, end, granularity),
    ]);

    const totalSales = round2(salesTotals.totalAmount);
    const netSales = round2(totalSales + adjustments.salesAdjustment);

    // Net Transaction Value: cash-consistent definition, identical to
    // Net Sales - see LOGIC.md §2.5/§5.1. Deliberately NOT the same
    // formula as the single-sale PaymentCard.jsx widget on Sale Detail,
    // which uses a different field (lineRefundAmount, not refundAmount)
    // for a narrower, per-sale purpose. That widget is untouched.
    const netTransactionValue = netSales;

    const grossProfit = round2(salesTotals.totalProfit + adjustments.profitAdjustment);
    // Profit After Tax delta = profit delta minus the GST portion of
    // that delta, mirroring Sale.totalProfitAfterGst's own definition
    // (totalProfit - gstAmount) applied at the adjustment level.
    const profitAfterTax = round2(salesTotals.totalProfitAfterGst + (adjustments.profitAdjustment - adjustments.gstAdjustment));

    const discountsGiven = round2(salesTotals.totalDiscount);
    const refunds = round2(returnRefunds + exchangeRefunds + tradeInRefunds);

    // Net Sales as the single canonical margin denominator across the
    // whole Analytics module - see LOGIC.md §2.13/§5.5 (the existing
    // P&L report uses three different, inconsistent denominators for
    // "margin %"; this module picks one and uses it everywhere).
    const profitMarginPercent = netSales > 0 ? round2((grossProfit / netSales) * 100) : 0;

    const payload = {
      period: { startDate: start, endDate: end },
      branch: branch ? { _id: branchObjectId, name: branch.name } : null,
      branches,
      money: {
        totalSales,
        netSales,
        totalPurchases: round2(totalPurchases),
        grossProfit,
        profitAfterTax,
        netTransactionValue,
        returnsValue: round2(returnsValue),
        refunds,
        discountsGiven,
        profitMarginPercent,
      },
      outstanding: {
        customerReceivable: round2(outstandingCustomer),
        vendorPayable: round2(vendorPayable),
      },
      collectionByMethod,
      revenueTrend,
    };

    return successResponse(res, "Money analytics retrieved successfully", payload);
  } catch (error) {
    console.error("Money Analytics Error:", error);
    return errorResponse(res, error.message || "Failed to load money analytics", 500);
  }
};

// ============================================================
// Total Sales / Gross Profit / Profit After Tax / Discounts Given -
// one pass over Sale's own frozen totals.
// ============================================================
const getSalesTotals = async (saleMatch) => {
  const [agg] = await Sale.aggregate([
    { $match: saleMatch },
    {
      $group: {
        _id: null,
        totalAmount: { $sum: "$totalAmount" },
        totalProfit: { $sum: "$totalProfit" },
        totalProfitAfterGst: { $sum: "$totalProfitAfterGst" },
        totalDiscount: { $sum: "$totalDiscount" },
      },
    },
  ]);
  return agg || { totalAmount: 0, totalProfit: 0, totalProfitAfterGst: 0, totalDiscount: 0 };
};

// ============================================================
// Total Purchases - excludes Type 2 Exchange trade-in acquisitions
// (Purchase.source "CUSTOMER_EXCHANGE"), matching the same convention
// already established in getDashboard.controller.js's Best Vendors/
// Branch Comparison widgets (a trade-in isn't a real vendor
// relationship). When scoped to one branch, a CENTRAL purchase is split
// by its own items.branchId/items.totalPrice (mirrors
// getBranchComparison's precise per-branch split) rather than summing
// the whole document's totalAmount into every branch it touches -
// Total Purchases is a headline Money figure, so it uses the accurate
// split rather than the coarser shortcut used elsewhere on the
// Dashboard.
// ============================================================
const getTotalPurchases = async (branchObjectId, start, end) => {
  const baseMatch = {
    status: "COMPLETED",
    isDeleted: false,
    source: { $ne: "CUSTOMER_EXCHANGE" },
    purchaseDate: { $gte: start, $lte: end },
  };

  if (!branchObjectId) {
    const [agg] = await Purchase.aggregate([{ $match: baseMatch }, { $group: { _id: null, total: { $sum: "$totalAmount" } } }]);
    return agg?.total || 0;
  }

  const [[branchAgg], [centralAgg]] = await Promise.all([
    Purchase.aggregate([
      { $match: { ...baseMatch, branchId: branchObjectId, poType: { $ne: "CENTRAL" } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]),
    Purchase.aggregate([
      { $match: { ...baseMatch, poType: "CENTRAL" } },
      { $unwind: "$items" },
      { $match: { "items.branchId": branchObjectId } },
      { $group: { _id: null, total: { $sum: "$items.totalPrice" } } },
    ]),
  ]);
  return (branchAgg?.total || 0) + (centralAgg?.total || 0);
};

// ============================================================
// Returns Value - original sale-value of returned line items (NOT the
// cash refunded - see Refunds below for that). Date field is
// createdAt, matching SaleReturn's own convention: it has no other
// business date field (see getReturnExchangeAdjustments.js's own
// comment). REJECTED returns are excluded, matching the same exclusion
// the shared adjustment service already applies everywhere else.
// ============================================================
const getReturnsValue = async (branchObjectId, start, end) => {
  const match = {
    isDeleted: false,
    processStatus: { $ne: "REJECTED" },
    createdAt: { $gte: start, $lte: end },
    ...(branchObjectId ? { branchId: branchObjectId } : {}),
  };
  const [agg] = await SaleReturn.aggregate([
    { $match: match },
    { $unwind: "$items" },
    { $group: { _id: null, total: { $sum: "$items.lineRefundAmount" } } },
  ]);
  return agg?.total || 0;
};

// ============================================================
// Refunds - actual cash paid back to customers: Return refunds plus
// Exchange/Trade-In settlements where the company paid the customer
// (never "CUSTOMER_PAYS", which is money coming IN, not a refund).
// ============================================================
const getReturnRefunds = async (branchObjectId, start, end) => {
  const match = {
    isDeleted: false,
    processStatus: { $ne: "REJECTED" },
    createdAt: { $gte: start, $lte: end },
    ...(branchObjectId ? { branchId: branchObjectId } : {}),
  };
  const [agg] = await SaleReturn.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: "$refundAmount" } } }]);
  return agg?.total || 0;
};

const getExchangeRefunds = async (branchObjectId, start, end) => {
  const match = {
    isDeleted: false,
    processStatus: { $ne: "REJECTED" },
    exchangedAt: { $gte: start, $lte: end },
    settlementType: "COMPANY_REFUNDS",
    ...(branchObjectId ? { branchId: branchObjectId } : {}),
  };
  const [agg] = await SaleExchange.aggregate([
    { $match: match },
    { $unwind: "$settlementDetails" },
    { $group: { _id: null, total: { $sum: "$settlementDetails.amount" } } },
  ]);
  return agg?.total || 0;
};

const getTradeInRefunds = async (branchObjectId, start, end) => {
  const match = {
    isDeleted: false,
    processStatus: { $ne: "REJECTED" },
    tradeInAt: { $gte: start, $lte: end },
    settlementType: "COMPANY_REFUNDS",
    ...(branchObjectId ? { branchId: branchObjectId } : {}),
  };
  const [agg] = await SaleTradeIn.aggregate([
    { $match: match },
    { $unwind: "$settlementDetails" },
    { $group: { _id: null, total: { $sum: "$settlementDetails.amount" } } },
  ]);
  return agg?.total || 0;
};

// ============================================================
// Outstanding Customer Payments / Vendor Payable - current-state, NOT
// period-bound (a receivable/payable balance is a "right now" figure,
// same convention as the main Dashboard's getPendingPayments()).
// ============================================================
const getOutstandingCustomerPayments = async (branchObjectId) => {
  const match = { status: "COMPLETED", isDeleted: false, pendingAmount: { $gt: 0 }, ...(branchObjectId ? { branchId: branchObjectId } : {}) };
  const [agg] = await Sale.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: "$pendingAmount" } } }]);
  return agg?.total || 0;
};

const getVendorPayable = async (branchObjectId) => {
  const match = {
    status: "COMPLETED",
    isDeleted: false,
    pendingAmount: { $gt: 0 },
    ...(branchObjectId ? purchaseBranchCondition(branchObjectId) : {}),
  };
  const [agg] = await Purchase.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: "$pendingAmount" } } }]);
  return agg?.total || 0;
};

// ============================================================
// Collection by Method - Cash/UPI/Card/Net Banking/Cheque/EMI, filtered
// by each individual payment's own paymentDate (not the sale's
// saleDate), so this reflects when money actually arrived, not when
// the sale was made.
// ============================================================
const getCollectionByMethod = async (branchObjectId, start, end) => {
  const match = { status: "COMPLETED", isDeleted: false, ...(branchObjectId ? { branchId: branchObjectId } : {}) };
  const rows = await Sale.aggregate([
    { $match: match },
    { $unwind: "$paymentDetails" },
    { $match: { "paymentDetails.paymentDate": { $gte: start, $lte: end } } },
    { $group: { _id: "$paymentDetails.paymentMethod", amount: { $sum: "$paymentDetails.amount" } } },
    { $sort: { amount: -1 } },
  ]);
  return rows.map((r) => ({ method: r._id || "CASH", amount: round2(r.amount) }));
};

// ============================================================
// Revenue Trend - Net Sales (Sale.totalAmount + Return/Exchange
// salesAdjustment) bucketed by local day/week/month - see
// analyticsDateUtils.js for why this is local time, not UTC.
// ============================================================
const getRevenueTrend = async (saleBranchMatch, adjustmentRows, start, end, granularity) => {
  const keyFn = localBucketKeyFor(granularity);
  const sales = await Sale.find({ status: "COMPLETED", isDeleted: false, saleDate: { $gte: start, $lte: end }, ...saleBranchMatch })
    .select("saleDate totalAmount")
    .lean();

  const buckets = new Map();
  for (const s of sales) {
    if (!s.saleDate) continue;
    const key = keyFn(s.saleDate);
    buckets.set(key, (buckets.get(key) || 0) + (s.totalAmount || 0));
  }
  for (const r of adjustmentRows) {
    const key = keyFn(r.date);
    buckets.set(key, (buckets.get(key) || 0) + r.salesAdjustment);
  }

  return [...buckets.entries()]
    .map(([date, netSales]) => ({ date, netSales: round2(netSales) }))
    .sort((a, b) => a.date.localeCompare(b.date));
};
