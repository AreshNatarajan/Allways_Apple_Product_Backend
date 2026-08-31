// services/reports/getReturnExchangeAdjustments.js
import SaleReturn from "../../models/SaleReturn.modal.js";
import SaleExchange from "../../models/SaleExchange.modal.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

// ============================================================
// Sale is a frozen historical record - a Return/Exchange never rewrites
// it (see Sale.modal.js's own frozen-fields design), so every P&L/
// Dashboard figure computed purely from Sale (as they all were before
// this file existed) overstates revenue/profit for anything later
// returned or exchanged. This is the ONE place that financial model
// lives - every report controller that needs it calls this and adds
// the numbers into sums it already computes, instead of re-deriving
// the model per-controller.
//
// RETURN - SaleReturn.items[] only stores unitPrice/lineRefundAmount
// (sellingPrice-based, no GST/discount awareness) and refundAmount is
// the real cash paid back (parent-doc level). Rather than adding new
// fields to SaleReturn (leaving every existing return without them),
// this does a live $lookup back to the original Sale, matching the
// specific line by productSerialId/batchId - the source of truth never
// changes, so this works identically for every return, old or new,
// with zero schema/migration risk. Assumes one item per return, which
// is how createSaleReturn.controller.js's only caller
// (SaleReturnModal.jsx) actually submits today (items: [oneItem]) -
// if that ever changes to genuinely multi-item, refundAmount would
// need per-line splitting, which it doesn't have.
//
// Per return line, for the returned quantity:
//   salesAdjustment   = -refundAmount (actual cash paid out)
//   costAdjustment    = -(matchedLine.purchasePrice * returnedQty) (stock
//                        is back in inventory, no longer COGS)
//   profitAdjustment  = (purchasePrice * qty) - refundAmount - a full
//                        refund nets that item's profit to exactly zero
//                        (as if never sold); a partial refund (restocking
//                        fee kept) leaves the fee as real profit.
//   gstAdjustment / purchaseGstAdjustment = matchedLine's own gstAmount/
//                        purchaseGstAmount, prorated to returnedQty
//                        (both are frozen LINE totals for the line's
//                        full original quantity), negated.
//
// EXCHANGE - SaleExchange.oldItem/newItem already carry complete frozen
// economics (purchasePrice/discount/gstAmount/finalAmount), enriched
// specifically for this - no live join needed, self-contained.
//   salesAdjustment  = newItem.finalAmount - oldItem.finalAmount
//                       (= the already-stored priceDifference)
//   costAdjustment   = newItem.purchasePrice - oldItem.purchasePrice
//   profitAdjustment = salesAdjustment - costAdjustment
//   gstAdjustment    = newItem.gstAmount - oldItem.gstAmount
//   The settlement cash itself needs no separate handling - the
//   backend already strictly enforces settlement total === |priceDifference|,
//   so it's fully captured by salesAdjustment above. purchaseGstAdjustment
//   is always 0 for an exchange - serialized-only phase, and a
//   serialized unit never carries input GST under the margin scheme.
//
// Period key: SaleReturn has no editable business date, so its
// createdAt is used (same convention as PurchaseEditHistory/
// SaleEditHistory). SaleExchange already has exchangedAt for this.
// ============================================================

const emptyTotals = () => ({
  salesAdjustment: 0,
  costAdjustment: 0,
  profitAdjustment: 0,
  gstAdjustment: 0,
  purchaseGstAdjustment: 0,
});

// Core fetch - one row per non-REJECTED Return/Exchange, each carrying
// its own date + delta. Deliberately NOT bucketed or summed here, so
// callers with a single fixed period (getProfitLoss.controller.js) and
// callers juggling several ad-hoc windows at once (getDashboard.controller.js's
// today/week/month/year/trend-range figures, mirroring how it already
// fetches raw Sale/Purchase rows once and facets them in JS rather than
// re-querying per window) can both build on the exact same rows without
// re-deriving the financial model twice. start/end optional - omit both
// for all-time (branch-scoped only).
export const getReturnExchangeAdjustmentRows = async ({ branchObjectId, start, end } = {}) => {
  const branchMatch = branchObjectId ? { branchId: branchObjectId } : {};

  const returnMatch = { isDeleted: false, processStatus: { $ne: "REJECTED" }, ...branchMatch };
  if (start && end) returnMatch.createdAt = { $gte: start, $lte: end };

  const exchangeMatch = { isDeleted: false, processStatus: { $ne: "REJECTED" }, ...branchMatch };
  if (start && end) exchangeMatch.exchangedAt = { $gte: start, $lte: end };

  const [returnRows, exchangeRows] = await Promise.all([
    SaleReturn.aggregate([
      { $match: returnMatch },
      { $unwind: "$items" },
      { $lookup: { from: "sales", localField: "saleId", foreignField: "_id", as: "sale" } },
      { $unwind: "$sale" },
      {
        $addFields: {
          matchedLine: {
            $first: {
              $filter: {
                input: "$sale.items",
                as: "it",
                cond: {
                  $cond: [
                    "$items.isSerialized",
                    { $eq: ["$$it.productSerialId", "$items.productSerialId"] },
                    { $eq: ["$$it.batchId", "$items.batchId"] },
                  ],
                },
              },
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          createdAt: 1,
          refundAmount: 1,
          quantity: "$items.quantity",
          matchedPurchasePrice: { $ifNull: ["$matchedLine.purchasePrice", 0] },
          matchedLineQuantity: { $ifNull: ["$matchedLine.quantity", 1] },
          matchedGstAmount: { $ifNull: ["$matchedLine.gstAmount", 0] },
          matchedPurchaseGstAmount: { $ifNull: ["$matchedLine.purchaseGstAmount", 0] },
        },
      },
    ]),
    SaleExchange.find(exchangeMatch).select("exchangedAt oldItem newItem priceDifference").lean(),
  ]);

  const rows = [];

  for (const r of returnRows) {
    const refund = r.refundAmount || 0;
    const qty = r.quantity || 0;
    const cost = (r.matchedPurchasePrice || 0) * qty;
    const lineQty = r.matchedLineQuantity > 0 ? r.matchedLineQuantity : 1;
    const gst = ((r.matchedGstAmount || 0) / lineQty) * qty;
    const purchaseGst = ((r.matchedPurchaseGstAmount || 0) / lineQty) * qty;

    rows.push({
      date: r.createdAt,
      salesAdjustment: -refund,
      costAdjustment: -cost,
      profitAdjustment: cost - refund,
      gstAdjustment: -gst,
      purchaseGstAdjustment: -purchaseGst,
    });
  }

  for (const ex of exchangeRows) {
    const salesAdjustment = (ex.newItem?.finalAmount || 0) - (ex.oldItem?.finalAmount || 0);
    const costAdjustment = (ex.newItem?.purchasePrice || 0) - (ex.oldItem?.purchasePrice || 0);
    const gstAdjustment = (ex.newItem?.gstAmount || 0) - (ex.oldItem?.gstAmount || 0);

    rows.push({
      date: ex.exchangedAt,
      salesAdjustment,
      costAdjustment,
      profitAdjustment: salesAdjustment - costAdjustment,
      gstAdjustment,
      purchaseGstAdjustment: 0,
    });
  }

  return rows;
};

// Sums an already-fetched row set (optionally re-filtered to a
// sub-window first) into one totals object - the plain-sum counterpart
// to sumRowsByDay below. Never re-queries the database.
export const sumAdjustmentRows = (rows) => {
  const totals = emptyTotals();
  for (const r of rows) {
    totals.salesAdjustment += r.salesAdjustment;
    totals.costAdjustment += r.costAdjustment;
    totals.profitAdjustment += r.profitAdjustment;
    totals.gstAdjustment += r.gstAdjustment;
    totals.purchaseGstAdjustment += r.purchaseGstAdjustment;
  }
  return {
    salesAdjustment: round2(totals.salesAdjustment),
    costAdjustment: round2(totals.costAdjustment),
    profitAdjustment: round2(totals.profitAdjustment),
    gstAdjustment: round2(totals.gstAdjustment),
    purchaseGstAdjustment: round2(totals.purchaseGstAdjustment),
  };
};

// Day-bucketed version of the same rows, for feeding trend charts the
// same way getTrend/getSalesTrend already bucket Sale data.
export const bucketAdjustmentRowsByDay = (rows) => {
  const buckets = new Map();
  for (const r of rows) {
    const key = dayKey(r.date);
    if (!buckets.has(key)) buckets.set(key, { date: key, ...emptyTotals() });
    const bucket = buckets.get(key);
    bucket.salesAdjustment += r.salesAdjustment;
    bucket.costAdjustment += r.costAdjustment;
    bucket.profitAdjustment += r.profitAdjustment;
    bucket.gstAdjustment += r.gstAdjustment;
    bucket.purchaseGstAdjustment += r.purchaseGstAdjustment;
  }
  return [...buckets.values()]
    .map((b) => ({
      date: b.date,
      salesAdjustment: round2(b.salesAdjustment),
      costAdjustment: round2(b.costAdjustment),
      profitAdjustment: round2(b.profitAdjustment),
      gstAdjustment: round2(b.gstAdjustment),
      purchaseGstAdjustment: round2(b.purchaseGstAdjustment),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
};

// Convenience wrapper for a single fixed period (getProfitLoss.controller.js's
// current/previous period calls) - fetches, sums, and buckets in one call.
export const getReturnExchangeAdjustments = async ({ branchObjectId, start, end } = {}) => {
  const rows = await getReturnExchangeAdjustmentRows({ branchObjectId, start, end });
  return {
    ...sumAdjustmentRows(rows),
    daily: bucketAdjustmentRowsByDay(rows),
  };
};
