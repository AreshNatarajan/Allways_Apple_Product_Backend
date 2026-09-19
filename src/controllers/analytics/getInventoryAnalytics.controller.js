// controllers/analytics/getInventoryAnalytics.controller.js
//
// GET /api/analytics/inventory - Pillar 2 (Inventory) of the Business
// Analytics module. Every formula's plain-English definition and the
// business decisions locked in for ageing buckets / slow-moving
// threshold live in
// shopping-frontend/docs/COMPLETE-ANALYTICS-IMPLEMENTATION-LOGIC.md §3 -
// this controller is that document implemented, nothing more.
//
// Route is SUPER_ADMIN-only (onlySuperAdmin middleware, see
// analytics.router.js), matching the Money pillar.
//
// Every "current state" figure here (Total/Available/Reserved/In-Transit/
// Damaged/Low-Stock/Out-of-Stock/Ageing) is a SNAPSHOT as of right now,
// NOT period-bound - same convention as the existing Inventory Dashboard
// (getInventoryDashboard.controller.js). "Sold Stock" is the one
// period-bound exception (it's a flow, not a balance), and uses the
// same startDate/endDate query params as the Money pillar.
//
// Source of truth: ProductSerial.status for serialized stock,
// BatchStock.availableQuantity for non-serialized - NEVER the legacy
// Inventory collection, which the earlier audit found drifts stale
// after every non-serialized Transfer (Transfer never touches it).

import mongoose from "mongoose";
import Branch from "../../models/Branch.modal.js";
import Product from "../../models/Product.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Transfer from "../../models/Transfer.modal.js";
import Sale from "../../models/Sale.modal.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { parseLocalDate, defaultMonthRange } from "../../services/analytics/analyticsDateUtils.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;
// Locked business decisions - see LOGIC.md §5.2/§5.3.
const SLOW_MOVING_DAYS = 60;
const ageBucketFor = (days) => (days <= 30 ? "0-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+");

export const getInventoryAnalyticsController = async (req, res) => {
  try {
    const { branchId, startDate, endDate } = req.query;
    const branchObjectId = branchId ? new mongoose.Types.ObjectId(branchId) : null;

    // Only used for Sold Stock (the one period-bound metric here).
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

    const [branches, branch, gstConfig] = await Promise.all([
      Branch.find({ isActive: true, isDeleted: false }).select("_id name code").sort({ name: 1 }).lean(),
      branchObjectId ? Branch.findById(branchObjectId).select("name").lean() : Promise.resolve(null),
      getOrCreateGstConfig(),
    ]);
    const thresholds = {
      serialized: gstConfig.inventory.serializedLowStockThreshold,
      nonSerialized: gstConfig.inventory.nonSerializedLowStockThreshold,
    };

    // ---- ONE fetch each of current AVAILABLE serials / ACTIVE batch
    // stock - every "current state" metric below (Total/Available
    // value, product-wise, branch-wise, ageing, low/out-of-stock,
    // slow-moving) is derived from these same two arrays in JS,
    // mirroring getDashboard.controller.js's getStockOverview/
    // getPeriodSections pattern (fetch once, reduce many ways) rather
    // than a separate query per metric.
    const serialFilter = { isDeleted: false, status: "AVAILABLE", ...(branchObjectId ? { currentBranchId: branchObjectId } : {}) };
    const batchFilter = { status: "ACTIVE", ...(branchObjectId ? { branchId: branchObjectId } : {}) };

    const [availableSerials, activeBatchStocks, reservedInTransit, damagedValue, soldStockValue, recentSaleKeys] = await Promise.all([
      ProductSerial.find(serialFilter).select("productId purchasePrice receivedAt currentBranchId").lean(),
      BatchStock.find(batchFilter).select("productId purchasePrice availableQuantity createdAt branchId").lean(),
      getReservedInTransitValue(branchObjectId),
      getDamagedValue(branchObjectId),
      getSoldStockValue(branchObjectId, start, end),
      getRecentSaleProductBranchKeys(branchObjectId, SLOW_MOVING_DAYS),
    ]);

    const now = Date.now();
    const slowMovingCutoff = now - SLOW_MOVING_DAYS * DAY_MS;

    let serializedValue = 0;
    let nonSerializedValue = 0;
    let slowMovingValue = 0;
    const ageBuckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
    const productMap = new Map(); // productId -> { value, qty, isSerialized }
    const branchMap = new Map(); // branchId -> { value }

    for (const s of availableSerials) {
      const value = s.purchasePrice || 0;
      serializedValue += value;

      const ageDays = s.receivedAt ? Math.floor((now - new Date(s.receivedAt).getTime()) / DAY_MS) : 0;
      ageBuckets[ageBucketFor(ageDays)] += value;
      if (ageDays > SLOW_MOVING_DAYS) slowMovingValue += value;

      const pKey = s.productId?.toString();
      if (pKey) {
        if (!productMap.has(pKey)) productMap.set(pKey, { value: 0, qty: 0, isSerialized: true });
        const p = productMap.get(pKey);
        p.value += value;
        p.qty += 1;
      }

      const bKey = s.currentBranchId?.toString();
      if (bKey) branchMap.set(bKey, (branchMap.get(bKey) || 0) + value);
    }

    for (const b of activeBatchStocks) {
      const value = (b.availableQuantity || 0) * (b.purchasePrice || 0);
      nonSerializedValue += value;

      const ageDays = b.createdAt ? Math.floor((now - new Date(b.createdAt).getTime()) / DAY_MS) : 0;
      ageBuckets[ageBucketFor(ageDays)] += value;

      const key = `${b.productId?.toString()}::${b.branchId?.toString()}`;
      if (!recentSaleKeys.has(key) && b.availableQuantity > 0) slowMovingValue += value;

      const pKey = b.productId?.toString();
      if (pKey) {
        if (!productMap.has(pKey)) productMap.set(pKey, { value: 0, qty: 0, isSerialized: false });
        const p = productMap.get(pKey);
        p.value += value;
        p.qty += b.availableQuantity || 0;
      }

      const bKey = b.branchId?.toString();
      if (bKey) branchMap.set(bKey, (branchMap.get(bKey) || 0) + value);
    }

    const totalValue = round2(serializedValue + nonSerializedValue);

    // ---- Low stock / Out of stock - same threshold convention as
    // getInventoryDashboard.controller.js / getDashboard.controller.js's
    // getStockOverview, just surfaced as its own Analytics widget.
    const lowStockItems = [];
    const outOfStockItems = [];
    for (const [productId, p] of productMap) {
      const threshold = p.isSerialized ? thresholds.serialized : thresholds.nonSerialized;
      if (p.qty === 0) outOfStockItems.push({ productId, qty: p.qty, value: round2(p.value), isSerialized: p.isSerialized });
      else if (p.qty <= threshold) lowStockItems.push({ productId, qty: p.qty, value: round2(p.value), isSerialized: p.isSerialized });
    }

    const nameLookupIds = [...productMap.keys()].filter(Boolean);
    const products = nameLookupIds.length
      ? await Product.find({ _id: { $in: nameLookupIds } }).select("name category").lean()
      : [];
    const nameMap = new Map(products.map((p) => [p._id.toString(), { name: p.name, category: p.category }]));

    const attachName = (row) => ({ ...row, productName: nameMap.get(row.productId)?.name || "Unknown Product" });

    const productWiseStock = [...productMap.entries()]
      .map(([productId, p]) => attachName({ productId, qty: p.qty, value: round2(p.value), isSerialized: p.isSerialized }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 20);

    // Branch-wise only makes sense when viewing "All Branches" -
    // scoped to one branch, every unit is already that one branch by
    // definition.
    const branchWiseStock = branchObjectId
      ? []
      : [...branchMap.entries()]
          .map(([bId, value]) => {
            const b = branches.find((br) => br._id.toString() === bId);
            return { branchId: bId, branchName: b?.name || "Unknown Branch", value: round2(value) };
          })
          .sort((a, b) => b.value - a.value);

    const ageing = Object.entries(ageBuckets).map(([bucket, value]) => ({ bucket, value: round2(value) }));

    const payload = {
      asOf: new Date(),
      period: { startDate: start, endDate: end },
      branch: branch ? { _id: branchObjectId, name: branch.name } : null,
      branches,
      inventory: {
        totalValue,
        availableValue: totalValue,
        serializedValue: round2(serializedValue),
        nonSerializedValue: round2(nonSerializedValue),
        reservedValue: round2(reservedInTransit.reservedValue),
        inTransitValue: round2(reservedInTransit.inTransitValue),
        damagedValue: round2(damagedValue),
        slowMovingValue: round2(slowMovingValue),
        soldStockValue: round2(soldStockValue),
      },
      lowStock: { count: lowStockItems.length, items: lowStockItems.map(attachName).sort((a, b) => a.qty - b.qty).slice(0, 20) },
      outOfStock: { count: outOfStockItems.length, items: outOfStockItems.map(attachName).slice(0, 20) },
      productWiseStock,
      branchWiseStock,
      ageing,
    };

    return successResponse(res, "Inventory analytics retrieved successfully", payload);
  } catch (error) {
    console.error("Inventory Analytics Error:", error);
    return errorResponse(res, error.message || "Failed to load inventory analytics", 500);
  }
};

// ============================================================
// Reserved / In-Transit - see LOGIC.md §3.17/§3.18. Serialized is a
// direct status query (RESERVED/IN_TRANSIT are real ProductSerial
// statuses). Non-serialized has NO dedicated status (a Transfer
// reservation just decrements BatchStock.availableQuantity at creation
// time) - split apart here by joining the open Transfer documents that
// actually hold the committed quantity, valued via a lookup back to
// BatchStock for purchasePrice (never stored on the Transfer itself).
//
// Branch semantics: "Reserved AT this branch" = stock still physically
// here, not yet dispatched (source branch for non-serialized /
// currentBranchId for serialized). "In-Transit TO this branch" = stock
// inbound, already dispatched (destination branch / assignedBranchId).
// With no branch filter (All Branches), every open Transfer/serial
// counts exactly once, keyed by its own current status - no double-count.
// ============================================================
const getReservedInTransitValue = async (branchObjectId) => {
  const serialMatch = { isDeleted: false, status: { $in: ["RESERVED", "IN_TRANSIT"] } };
  const serials = await ProductSerial.find(serialMatch).select("status currentBranchId assignedBranchId purchasePrice").lean();

  let reservedValue = 0;
  let inTransitValue = 0;
  for (const s of serials) {
    if (s.status === "RESERVED" && (!branchObjectId || String(s.currentBranchId) === String(branchObjectId))) {
      reservedValue += s.purchasePrice || 0;
    }
    if (s.status === "IN_TRANSIT" && (!branchObjectId || String(s.assignedBranchId) === String(branchObjectId))) {
      inTransitValue += s.purchasePrice || 0;
    }
  }

  const transferMatch = { isDeleted: false, status: { $in: ["PROCESSING", "PACKED", "DISPATCHED"] } };
  if (branchObjectId) transferMatch.$or = [{ sourceBranchId: branchObjectId }, { destinationBranchId: branchObjectId }];

  const rows = await Transfer.aggregate([
    { $match: transferMatch },
    { $unwind: "$items" },
    { $match: { "items.isSerialized": false } },
    { $unwind: "$items.sourceBatches" },
    { $lookup: { from: "batchstocks", localField: "items.sourceBatches.batchStockId", foreignField: "_id", as: "bs" } },
    { $unwind: "$bs" },
    {
      $project: {
        status: 1,
        sourceBranchId: 1,
        destinationBranchId: 1,
        value: { $multiply: ["$items.sourceBatches.quantity", "$bs.purchasePrice"] },
      },
    },
  ]);

  for (const r of rows) {
    const isReserved = (r.status === "PROCESSING" || r.status === "PACKED") && (!branchObjectId || String(r.sourceBranchId) === String(branchObjectId));
    const isInTransit = r.status === "DISPATCHED" && (!branchObjectId || String(r.destinationBranchId) === String(branchObjectId));
    if (isReserved) reservedValue += r.value || 0;
    if (isInTransit) inTransitValue += r.value || 0;
  }

  return { reservedValue, inTransitValue };
};

// ============================================================
// Damaged Stock - see LOGIC.md §3.19. Both halves are already
// maintained running values, pure read, no derivation.
// ============================================================
const getDamagedValue = async (branchObjectId) => {
  const serialMatch = { isDeleted: false, status: "DAMAGED", ...(branchObjectId ? { currentBranchId: branchObjectId } : {}) };
  const batchMatch = { status: { $ne: "CANCELLED" }, damagedQuantity: { $gt: 0 }, ...(branchObjectId ? { branchId: branchObjectId } : {}) };

  const [[serialAgg], batchRows] = await Promise.all([
    ProductSerial.aggregate([{ $match: serialMatch }, { $group: { _id: null, total: { $sum: "$purchasePrice" } } }]),
    BatchStock.find(batchMatch).select("damagedQuantity purchasePrice").lean(),
  ]);

  const serializedDamaged = serialAgg?.total || 0;
  const nonSerializedDamaged = batchRows.reduce((sum, b) => sum + (b.damagedQuantity || 0) * (b.purchasePrice || 0), 0);
  return serializedDamaged + nonSerializedDamaged;
};

// ============================================================
// Sold Stock (period) - Cost of Goods Sold for the selected period,
// see LOGIC.md §3.16. The one period-bound Inventory metric.
// ============================================================
const getSoldStockValue = async (branchObjectId, start, end) => {
  const match = { status: "COMPLETED", isDeleted: false, saleDate: { $gte: start, $lte: end }, ...(branchObjectId ? { branchId: branchObjectId } : {}) };
  const [agg] = await Sale.aggregate([
    { $match: match },
    { $unwind: "$items" },
    {
      $group: {
        _id: null,
        total: { $sum: { $multiply: ["$items.purchasePrice", { $cond: ["$items.isSerialized", 1, "$items.quantity"] }] } },
      },
    },
  ]);
  return agg?.total || 0;
};

// ============================================================
// Recent-sale lookup for non-serialized Slow-moving (LOGIC.md §3.24) -
// a Set of "productId::branchId" keys that had at least one completed
// Sale in the last N days, so a BatchStock row can be checked for
// "no sale referencing this product at this branch recently" without a
// per-row query.
// ============================================================
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
