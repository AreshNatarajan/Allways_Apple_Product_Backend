// controllers/service/getServiceProducts.controller.js
import mongoose from "mongoose";
import Service from "../../models/Service.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every status that means "the product is still somewhere in the
// service journey" (not yet back with its owner, not cancelled).
const IN_SERVICE_STATUSES = [
  "CUSTOMER_RECEIVED", "SENT_TO_SERVICE_BRANCH", "SERVICE_BRANCH_RECEIVED", "VENDOR_ALLOCATED",
  "VENDOR_PROCESSING", "VENDOR_RETURNED", "FINISHED", "SENT_TO_ORIGINAL_BRANCH",
];

// ============================================================
// SERVICE PRODUCTS - one row per physical item that ever entered
// service (a ticket with 3 items = 3 rows). Read-only.
//
// In date  = when the ticket was created (item received for service).
// Out date = when its service journey ended:
//   SERVICE_COMPLETED                     -> completedAt (customer collected it)
//   ORIGINAL_BRANCH_RECEIVED (INVENTORY)  -> originalBranchReceivedAt (back in stock)
//   CANCELLED                             -> cancelledAt
//   anything else                         -> null (still in service)
//
// Branch scope matches getAllServices: SUPER_ADMIN sees everything (or
// one branch via branchId); everyone else only tickets where their
// branch is the origin or the Service branch.
//
// Query: page, limit, search, stage (ALL|IN_SERVICE|COMPLETED|CANCELLED),
// status, serviceType, category, repairOutcome (REPAIRED|UNABLE_TO_REPAIR|PENDING),
// branchId, serviceVendorId, productId, startDate/endDate (in-date range),
// outStartDate/outEndDate (out-date range).
// ============================================================
export const getServiceProductsController = async (req, res) => {
  try {
    const user = req.user;
    const {
      page = 1, limit = 10, search = "", stage = "ALL", status = "ALL", serviceType = "ALL",
      category = "ALL", repairOutcome = "ALL", branchId, serviceVendorId, startDate, endDate,
      productId, outStartDate, outEndDate,
    } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit) || 10));

    // ---- ticket-level filters (before unwinding) ----
    const ticketMatch = { isDeleted: false };
    const scopeBranchId = user.role === "SUPER_ADMIN" ? branchId : user.branchId?.toString();
    if (scopeBranchId && scopeBranchId !== "ALL" && mongoose.Types.ObjectId.isValid(scopeBranchId)) {
      const b = new mongoose.Types.ObjectId(scopeBranchId);
      ticketMatch.$or = [{ originBranchId: b }, { serviceBranchId: b }];
    } else if (user.role !== "SUPER_ADMIN") {
      return errorResponse(res, "Branch not assigned to user", 400);
    }
    if (serviceType && serviceType !== "ALL") ticketMatch.serviceType = serviceType;
    if (status && status !== "ALL") ticketMatch.status = status;
    if (serviceVendorId && mongoose.Types.ObjectId.isValid(serviceVendorId)) {
      ticketMatch.serviceVendorId = new mongoose.Types.ObjectId(serviceVendorId);
    }
    if (repairOutcome === "REPAIRED" || repairOutcome === "UNABLE_TO_REPAIR") ticketMatch.repairOutcome = repairOutcome;
    else if (repairOutcome === "PENDING") ticketMatch.repairOutcome = null;
    if (startDate || endDate) {
      const range = {};
      if (startDate) range.$gte = new Date(`${startDate}T00:00:00.000Z`);
      if (endDate) range.$lte = new Date(`${endDate}T23:59:59.999Z`);
      ticketMatch.createdAt = range;
    }

    // ---- row-level filters (after unwinding + lookups) ----
    const rowMatch = {};
    if (stage === "IN_SERVICE") rowMatch.stage = "IN_SERVICE";
    else if (stage === "COMPLETED") rowMatch.stage = "COMPLETED";
    else if (stage === "CANCELLED") rowMatch.stage = "CANCELLED";
    if (category && category !== "ALL") rowMatch.category = category;
    if (productId && mongoose.Types.ObjectId.isValid(productId)) rowMatch.productId = new mongoose.Types.ObjectId(productId);
    if (outStartDate || outEndDate) {
      const range = {};
      if (outStartDate) range.$gte = new Date(`${outStartDate}T00:00:00.000Z`);
      if (outEndDate) range.$lte = new Date(`${outEndDate}T23:59:59.999Z`);
      rowMatch.outDate = range;
    }
    if (search?.trim()) {
      const rx = new RegExp(escapeRegex(search.trim()), "i");
      rowMatch.$or = [
        { productName: rx }, { serialNumber: rx }, { serviceNumber: rx }, { issueDescription: rx }, { condition: rx },
        { customerName: rx }, { customerMobile: rx }, { modelNumber: rx },
      ];
    }

    const pipeline = [
      { $match: ticketMatch },
      // Tickets from before items[] existed kept one product on the
      // document itself (see services/service/normalizeLegacyServiceItems.js).
      {
        $addFields: {
          items: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$items", []] } }, 0] },
              "$items",
              {
                $cond: [
                  { $ifNull: ["$productId", false] },
                  [{
                    productId: "$productId", productName: "", productSerialId: "$productSerialId",
                    serialNumberText: { $ifNull: ["$serialNumberText", ""] }, issueDescription: { $ifNull: ["$issueDescription", ""] },
                    description: { main: "", second: "" }, images: [],
                  }],
                  [],
                ],
              },
            ],
          },
        },
      },
      { $unwind: { path: "$items", includeArrayIndex: "itemIndex" } },
      { $lookup: { from: "products", localField: "items.productId", foreignField: "_id", as: "_product", pipeline: [{ $project: { name: 1, category: 1, modelNumber: 1 } }] } },
      { $lookup: { from: "productserials", localField: "items.productSerialId", foreignField: "_id", as: "_unit", pipeline: [{ $project: { serialNumber: 1, images: 1, description: 1 } }] } },
      { $lookup: { from: "servicevendors", localField: "serviceVendorId", foreignField: "_id", as: "_vendor", pipeline: [{ $project: { name: 1, phone: 1 } }] } },
      {
        $project: {
          _id: 0,
          rowId: { $concat: [{ $toString: "$_id" }, "-", { $toString: "$itemIndex" }] },
          serviceId: "$_id",
          itemIndex: 1,
          serviceNumber: 1,
          reServiceOf: { $ifNull: ["$items.reServiceOf", null] },
          serviceType: 1,
          status: 1,
          repairOutcome: 1,
          repairOutcomeNotes: 1,
          productId: "$items.productId",
          productName: { $ifNull: [{ $first: "$_product.name" }, "$items.productName"] },
          category: { $first: "$_product.category" },
          modelNumber: { $first: "$_product.modelNumber" },
          serialNumber: {
            $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$items.serialNumberText", ""] } }, 0] }, "$items.serialNumberText", { $ifNull: [{ $first: "$_unit.serialNumber" }, ""] }],
          },
          issueDescription: "$items.issueDescription",
          // Customer-owned items carry their own intake description; an
          // INVENTORY item uses its unit's description.
          condition: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ["$items.description.main", ""] } }, 0] },
              "$items.description.main",
              { $ifNull: [{ $first: "$_unit.description.main" }, ""] },
            ],
          },
          // Customer-owned items carry their own intake photos; an
          // INVENTORY item shows its unit's catalogue photos.
          images: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$items.images", []] } }, 0] },
              "$items.images",
              { $ifNull: [{ $first: "$_unit.images" }, []] },
            ],
          },
          customerName: { $ifNull: ["$customerSnapshot.name", ""] },
          customerMobile: { $ifNull: ["$customerSnapshot.mobile", ""] },
          originBranchName: 1,
          serviceBranchName: 1,
          vendorName: { $ifNull: [{ $first: "$_vendor.name" }, ""] },
          inDate: "$createdAt",
          outDate: {
            $switch: {
              branches: [
                { case: { $eq: ["$status", "SERVICE_COMPLETED"] }, then: "$completedAt" },
                { case: { $and: [{ $eq: ["$status", "ORIGINAL_BRANCH_RECEIVED"] }, { $eq: ["$serviceType", "INVENTORY"] }] }, then: "$originalBranchReceivedAt" },
                { case: { $eq: ["$status", "CANCELLED"] }, then: "$cancelledAt" },
              ],
              default: null,
            },
          },
          stage: {
            $switch: {
              branches: [
                { case: { $eq: ["$status", "CANCELLED"] }, then: "CANCELLED" },
                { case: { $eq: ["$status", "SERVICE_COMPLETED"] }, then: "COMPLETED" },
                { case: { $and: [{ $eq: ["$status", "ORIGINAL_BRANCH_RECEIVED"] }, { $eq: ["$serviceType", "INVENTORY"] }] }, then: "COMPLETED" },
              ],
              default: "IN_SERVICE",
            },
          },
        },
      },
      { $project: { "images._id": 0, "images.key": 0 } },
    ];

    // Counts per stage honour every filter EXCEPT the stage filter itself,
    // so the summary chips always show the full split.
    const { stage: _ignored, ...rowMatchWithoutStage } = rowMatch;
    const stageMatch = rowMatch.stage ? [{ $match: { stage: rowMatch.stage } }] : [];

    const [result] = await Service.aggregate([
      ...pipeline,
      ...(Object.keys(rowMatchWithoutStage).length ? [{ $match: rowMatchWithoutStage }] : []),
      {
        $facet: {
          counts: [{ $group: { _id: "$stage", n: { $sum: 1 } } }],
          rows: [
            ...stageMatch,
            { $sort: { inDate: -1, rowId: 1 } },
            { $skip: (pageNum - 1) * limitNum },
            { $limit: limitNum },
            // Later tickets that re-serviced THIS item (same ticket + item
            // index) - drives the Re-service action and the row tag.
            {
              $lookup: {
                from: "services",
                let: { sid: "$serviceId", idx: "$itemIndex" },
                pipeline: [
                  { $match: { isDeleted: false, $expr: { $in: ["$$sid", { $ifNull: ["$items.reServiceOf.serviceId", []] }] } } },
                  {
                    $project: {
                      serviceNumber: 1, status: 1, serviceType: 1, createdAt: 1,
                      hit: { $filter: { input: "$items", cond: { $and: [{ $eq: ["$$this.reServiceOf.serviceId", "$$sid"] }, { $eq: ["$$this.reServiceOf.itemIndex", "$$idx"] }] } } },
                    },
                  },
                  { $match: { "hit.0": { $exists: true } } },
                  { $project: { hit: 0 } },
                  { $sort: { createdAt: 1 } },
                ],
                as: "reServices",
              },
            },
          ],
          total: [...stageMatch, { $count: "n" }],
        },
      },
    ]);

    const counts = { IN_SERVICE: 0, COMPLETED: 0, CANCELLED: 0 };
    for (const c of result?.counts || []) counts[c._id] = c.n;
    const total = result?.total?.[0]?.n || 0;

    return successResponse(res, "Service products retrieved successfully", {
      products: result?.rows || [],
      counts,
      inServiceStatuses: IN_SERVICE_STATUSES,
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
    });
  } catch (error) {
    console.error("Get Service Products Error:", error);
    return errorResponse(res, "Failed to retrieve service products", 500);
  }
};
