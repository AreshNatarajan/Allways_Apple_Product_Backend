// services/purchase/vendorCredit.js
import PurchaseReturn from "../../models/PurchaseReturn.modal.js";
import Purchase from "../../models/Purchase.modal.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ============================================================
// Vendor credit netting - read-time only.
//
// A VENDOR_CREDIT PurchaseReturn (only allowed on a purchase with no
// payment yet - see createPurchaseReturn.controller.js) sends goods back
// with no money moving. The Purchase document itself is never touched
// (its pendingAmount stays as entered, so Purchase Edit's own
// totalAmount - paidAmount recalculation is unaffected); instead every
// "what we still owe the vendor" figure subtracts the credit here.
//
// Every non-deleted VENDOR_CREDIT return counts, whatever its EOD
// processStatus - review is audit-only (reviewPurchase.controller.js
// never reverses stock), so a REJECTED return's goods are still gone.
//
// Profit/P&L needs no netting: profit is only ever taken from SOLD
// items, and a returned unit (RETURNED_TO_VENDOR / reduced batch
// stock) can never be sold.
// ============================================================

const VENDOR_CREDIT_MATCH = { isDeleted: false, settlementType: "VENDOR_CREDIT" };

// purchaseId string -> total vendor credit, for an in-memory list of
// purchases.
export const getVendorCreditByPurchase = async (purchaseIds) => {
  if (!purchaseIds || purchaseIds.length === 0) return new Map();
  const rows = await PurchaseReturn.aggregate([
    { $match: { ...VENDOR_CREDIT_MATCH, purchaseId: { $in: purchaseIds } } },
    { $group: { _id: "$purchaseId", total: { $sum: "$returnAmount" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.total || 0]));
};

// What is still owed on one purchase once its vendor credit is applied -
// never below 0.
// Purchases whose whole pendingAmount is covered by vendor credit - they
// owe nothing after netting, so the "Balance Due" list filter
// (getAllPurchases.controller.js) excludes them, matching the Dashboard's
// Purchase Pending Payment card. Only purchases with a VENDOR_CREDIT
// return are checked, so this stays a small query.
export const getPurchaseIdsFullyCoveredByVendorCredit = async () => {
  const rows = await PurchaseReturn.aggregate([
    { $match: VENDOR_CREDIT_MATCH },
    { $group: { _id: "$purchaseId", total: { $sum: "$returnAmount" } } },
  ]);
  if (rows.length === 0) return [];
  const creditById = new Map(rows.map((r) => [String(r._id), r.total || 0]));
  const purchases = await Purchase.find({ _id: { $in: rows.map((r) => r._id) } }).select("pendingAmount").lean();
  return purchases
    .filter((p) => netPendingAfterVendorCredit(p.pendingAmount, creditById.get(String(p._id))) <= 0)
    .map((p) => p._id);
};

export const netPendingAfterVendorCredit = (pendingAmount, vendorCredit) =>
  round2(Math.max(0, (Number(pendingAmount) || 0) - (Number(vendorCredit) || 0)));

// Aggregation stages for a Purchase pipeline: adds `netPendingAmount`
// (pendingAmount minus that purchase's vendor credit, floored at 0).
// Sum `$netPendingAmount` instead of `$pendingAmount` afterwards.
export const netPendingStages = () => [
  {
    $lookup: {
      from: PurchaseReturn.collection.name,
      let: { pid: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$purchaseId", "$$pid"] }, ...VENDOR_CREDIT_MATCH } },
        { $group: { _id: null, total: { $sum: "$returnAmount" } } },
      ],
      as: "_vendorCredit",
    },
  },
  {
    $addFields: {
      netPendingAmount: {
        $max: [
          0,
          {
            $subtract: [
              { $ifNull: ["$pendingAmount", 0] },
              { $ifNull: [{ $arrayElemAt: ["$_vendorCredit.total", 0] }, 0] },
            ],
          },
        ],
      },
    },
  },
];
