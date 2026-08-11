// controllers/pendingReceives/getPendingReceives.controller.js
import mongoose from "mongoose";
import PendingReceive from "../../models/PendingReceive.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import paginate from "../../utils/pagination.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Mongo-side mirror of services/pendingReceive/receiveStatusHelper.js's
// deriveStatus() - duplicated as an aggregation expression (rather than
// called from JS) because this status has to be computed and filtered
// on INSIDE the database for pagination to work correctly; the same
// precedence rules are kept in lockstep with the JS version by hand.
const STATUS_EXPR = {
  $switch: {
    branches: [
      { case: { $lte: ["$totalProcessed", 0] }, then: "PENDING" },
      { case: { $lt: ["$totalProcessed", "$assignedQty"] }, then: "PARTIAL" },
      {
        case: {
          $and: [{ $gt: ["$damagedQty", 0] }, { $eq: ["$receivedQty", 0] }, { $eq: ["$missingQty", 0] }, { $eq: ["$rejectedQty", 0] }],
        },
        then: "DAMAGED",
      },
      {
        case: {
          $and: [{ $gt: ["$missingQty", 0] }, { $eq: ["$receivedQty", 0] }, { $eq: ["$damagedQty", 0] }, { $eq: ["$rejectedQty", 0] }],
        },
        then: "MISSING",
      },
      {
        case: {
          $and: [{ $gt: ["$rejectedQty", 0] }, { $eq: ["$receivedQty", 0] }, { $eq: ["$damagedQty", 0] }, { $eq: ["$missingQty", 0] }],
        },
        then: "REJECTED",
      },
      {
        case: { $or: [{ $gt: ["$damagedQty", 0] }, { $gt: ["$missingQty", 0] }, { $gt: ["$rejectedQty", 0] }] },
        then: "PARTIAL",
      },
    ],
    default: "COMPLETED",
  },
};

export const getPendingReceivesController = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const user = req.user;
    const { search, purchaseNumber, vendorId, branchId, status, startDate, endDate } = req.query;

    // ============================================================
    // BRANCH SCOPE - SUPER_ADMIN gets an optional filter (unscoped =
    // every branch); BRANCH_ADMIN/STAFF are always force-scoped to
    // their own branch, inline (never via the shared getBranchFilter
    // helper - it has a known gap for STAFF, returning {} unscoped).
    // ============================================================
    let scopedBranchId = null;
    if (user.role === "SUPER_ADMIN") {
      if (branchId && branchId !== "ALL" && mongoose.Types.ObjectId.isValid(branchId)) {
        scopedBranchId = new mongoose.Types.ObjectId(branchId);
      }
    } else {
      if (!user.branchId) return errorResponse(res, "Branch not assigned to user", 400);
      scopedBranchId = new mongoose.Types.ObjectId(user.branchId);
    }

    // ============================================================
    // SOURCE 1 - non-serialized progress, from PendingReceive.items[]
    // ============================================================
    const nonSerialMatch = { isDeleted: false };
    if (scopedBranchId) nonSerialMatch.branchId = scopedBranchId;

    const nonSerialPipeline = [
      { $match: nonSerialMatch },
      {
        $project: {
          _id: 0,
          purchaseId: 1,
          branchId: 1,
          assignedQty: { $sum: "$items.orderedQuantity" },
          receivedQty: { $sum: "$items.receivedQuantity" },
          damagedQty: { $sum: "$items.damagedQuantity" },
          missingQty: { $sum: "$items.missingQuantity" },
          rejectedQty: { $sum: "$items.rejectedQuantity" },
        },
      },
    ];

    // ============================================================
    // SOURCE 2 - serialized progress, from ProductSerial grouped by
    // {purchaseId, assignedBranchId}. Serialized units never get a
    // PendingReceive row (that collection is explicitly scoped to
    // non-serialized lines - see PendingReceive.modal.js) - their
    // pending/received state lives entirely on ProductSerial itself,
    // so this is the only way to represent them in the list at all.
    // assignedBranchId is set once at purchase time and never cleared
    // by the receive flow, so grouping by it still works for
    // already-completed rows, not just pending ones.
    // ============================================================
    const serialMatch = { isDeleted: false, assignedBranchId: { $ne: null } };
    if (scopedBranchId) serialMatch.assignedBranchId = scopedBranchId;

    const serialPipeline = [
      { $match: serialMatch },
      {
        $group: {
          _id: { purchaseId: "$purchaseId", branchId: "$assignedBranchId" },
          assignedQty: { $sum: 1 },
          receivedQty: {
            $sum: { $cond: [{ $and: [{ $eq: ["$status", "AVAILABLE"] }, { $ne: ["$receivedAt", null] }] }, 1, 0] },
          },
          damagedQty: { $sum: { $cond: [{ $eq: ["$status", "DAMAGED"] }, 1, 0] } },
          missingQty: { $sum: { $cond: [{ $eq: ["$status", "MISSING"] }, 1, 0] } },
        },
      },
      {
        $project: {
          _id: 0,
          purchaseId: "$_id.purchaseId",
          branchId: "$_id.branchId",
          assignedQty: 1,
          receivedQty: 1,
          damagedQty: 1,
          missingQty: 1,
          rejectedQty: { $literal: 0 },
        },
      },
    ];

    // ============================================================
    // UNION + MERGE - one row per {purchaseId, branchId}, combining
    // both sources' quantity buckets, computed in the database so
    // pagination/sorting/status-filtering all happen on real totals,
    // never client-side.
    // ============================================================
    const pipeline = [
      ...nonSerialPipeline,
      { $unionWith: { coll: "productserials", pipeline: serialPipeline } },
      {
        $group: {
          _id: { purchaseId: "$purchaseId", branchId: "$branchId" },
          assignedQty: { $sum: "$assignedQty" },
          receivedQty: { $sum: "$receivedQty" },
          damagedQty: { $sum: "$damagedQty" },
          missingQty: { $sum: "$missingQty" },
          rejectedQty: { $sum: "$rejectedQty" },
        },
      },
      {
        $addFields: {
          purchaseId: "$_id.purchaseId",
          branchId: "$_id.branchId",
          totalProcessed: { $add: ["$receivedQty", "$damagedQty", "$missingQty", "$rejectedQty"] },
        },
      },
      { $addFields: { status: STATUS_EXPR } },
      {
        $addFields: {
          receivePercent: {
            $cond: [
              { $lte: ["$assignedQty", 0] },
              0,
              { $round: [{ $multiply: [{ $divide: ["$receivedQty", "$assignedQty"] }, 100] }, 2] },
            ],
          },
        },
      },
      { $lookup: { from: "purchases", localField: "purchaseId", foreignField: "_id", as: "purchase" } },
      { $unwind: "$purchase" },
      { $lookup: { from: "branches", localField: "branchId", foreignField: "_id", as: "branch" } },
      { $unwind: "$branch" },
      { $lookup: { from: "vendors", localField: "purchase.vendorId", foreignField: "_id", as: "vendor" } },
      { $unwind: { path: "$vendor", preserveNullAndEmptyArrays: true } },
    ];

    // ============================================================
    // FILTERS applied after the join (status/date/search all need the
    // joined purchase/vendor/branch fields)
    // ============================================================
    const postJoinMatch = {};

    if (status && status !== "ALL") postJoinMatch.status = status;

    if (vendorId && mongoose.Types.ObjectId.isValid(vendorId)) {
      postJoinMatch["purchase.vendorId"] = new mongoose.Types.ObjectId(vendorId);
    }

    if (purchaseNumber && purchaseNumber.trim() !== "") {
      postJoinMatch["purchase.purchaseNumber"] = new RegExp(escapeRegex(purchaseNumber.trim()), "i");
    }

    if (startDate || endDate) {
      postJoinMatch["purchase.purchaseDate"] = {};
      if (startDate) postJoinMatch["purchase.purchaseDate"].$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        postJoinMatch["purchase.purchaseDate"].$lte = end;
      }
    }

    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(escapeRegex(search.trim()), "i");
      postJoinMatch.$or = [
        { "purchase.purchaseNumber": searchRegex },
        { "vendor.name": searchRegex },
        { "branch.name": searchRegex },
        { "branch.code": searchRegex },
      ];
    }

    if (Object.keys(postJoinMatch).length > 0) {
      pipeline.push({ $match: postJoinMatch });
    }

    pipeline.push({ $sort: { "purchase.purchaseDate": -1, _id: -1 } });

    pipeline.push({
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              purchaseId: 1,
              branchId: 1,
              receiveKey: { $concat: [{ $toString: "$purchaseId" }, "::", { $toString: "$branchId" }] },
              purchaseNumber: "$purchase.purchaseNumber",
              vendor: {
                _id: "$vendor._id",
                name: { $ifNull: ["$vendor.name", ""] },
                phone: { $ifNull: ["$vendor.phone", ""] },
              },
              branch: { _id: "$branch._id", name: "$branch.name", code: "$branch.code" },
              purchaseDate: "$purchase.purchaseDate",
              assignedQty: 1,
              receivedQty: 1,
              pendingQty: { $subtract: ["$assignedQty", "$totalProcessed"] },
              receivePercent: 1,
              status: 1,
            },
          },
        ],
        totalCount: [{ $count: "count" }],
      },
    });

    const [result] = await PendingReceive.aggregate(pipeline);
    const data = result?.data || [];
    const total = result?.totalCount?.[0]?.count || 0;

    return successResponse(res, "Pending receives retrieved successfully", {
      list: data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 0,
      },
      filters: {
        search: search || "",
        purchaseNumber: purchaseNumber || "",
        vendorId: vendorId || "",
        branchId: branchId || "ALL",
        status: status || "ALL",
        startDate: startDate || null,
        endDate: endDate || null,
      },
    });
  } catch (error) {
    console.error("Get Pending Receives Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve pending receives", 500);
  }
};
