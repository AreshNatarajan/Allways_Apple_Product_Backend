// controllers/transfer/getPendingTransfers.controller.js
import mongoose from "mongoose";
import Transfer from "../../models/Transfer.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const ALL_STATUSES = ["REQUESTED", "ACCEPTED", "PACKED", "DISPATCHED", "RECEIVED", "COMPLETED", "CANCELLED"];

export const getPendingTransfersController = async (req, res) => {
  try {
    const user = req.user;
    const { page = 1, limit = 10, search = "", status = "ALL", view, branchId: branchIdParam } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { isDeleted: false };

    // ============================================================
    // OWNERSHIP - "My Requests" (this branch created it) vs "Other
    // Requests" (another branch requested stock FROM this branch, so
    // this branch is the source but not the creator). A transfer never
    // disappears from its tab when its status changes - both tabs show
    // the complete lifecycle, REQUESTED all the way through COMPLETED/
    // CANCELLED, not just the "needs action" subset.
    //
    // SUPER_ADMIN has no branch of their own; an explicit `branchId`
    // query param lets them view the split as any branch would see it,
    // omitting it keeps the previous "everything, unscoped" behavior.
    // ============================================================
    const scopeBranchId = user.role === "SUPER_ADMIN" ? branchIdParam : user.branchId;

    if (scopeBranchId) {
      const branchObjectId = new mongoose.Types.ObjectId(scopeBranchId);
      if (view === "mine") {
        filter.createdByBranchId = branchObjectId;
      } else if (view === "other") {
        filter.sourceBranchId = branchObjectId;
        filter.createdByBranchId = { $ne: branchObjectId };
      } else {
        filter.$or = [{ createdByBranchId: branchObjectId }, { sourceBranchId: branchObjectId }];
      }
    } else if (user.role !== "SUPER_ADMIN") {
      return errorResponse(res, "Branch not assigned to user", 400);
    }
    // SUPER_ADMIN with no branchId param and no specific view: no scope
    // filter at all - sees every transfer, matching prior behavior.

    if (status && status !== "ALL") {
      filter.status = status;
    } else {
      filter.status = { $in: ALL_STATUSES };
    }

    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const searchConditions = [
        { transferNumber: searchRegex },
        { sourceBranchName: searchRegex },
        { destinationBranchName: searchRegex },
        { "items.productName": searchRegex },
        { "items.productCode": searchRegex },
        { notes: searchRegex },
      ];
      filter.$and = [...(filter.$and || []), { $or: searchConditions }];
    }

    const transfers = await Transfer.find(filter)
      .populate("sourceBranchId", "name code")
      .populate("destinationBranchId", "name code")
      .populate("createdBy", "name email")
      .populate("acceptedBy", "name email")
      .populate("packedBy", "name email")
      .populate("dispatchedBy", "name email")
      .populate("receivedBy", "name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Transfer.countDocuments(filter);

    const transformedTransfers = transfers.map((transfer) => {
      const totalQuantity = transfer.items.reduce((sum, item) => sum + item.quantity, 0);
      const totalPacked = transfer.items.reduce(
        (sum, item) => sum + (item.isSerialized ? item.serials.length : item.packedQuantity || 0),
        0
      );
      const totalReceived = transfer.items.reduce(
        (sum, item) =>
          sum + (item.isSerialized ? item.serials.filter((s) => s.condition === "GOOD").length : item.receivedQuantity || 0),
        0
      );

      return {
        _id: transfer._id,
        transferNumber: transfer.transferNumber,
        sourceBranch: transfer.sourceBranchId || { name: transfer.sourceBranchName },
        destinationBranch: transfer.destinationBranchId || { name: transfer.destinationBranchName },
        sourceBranchName: transfer.sourceBranchName,
        destinationBranchName: transfer.destinationBranchName,
        createdByBranchId: transfer.createdByBranchId,
        createdByBranchName: transfer.createdByBranchName,

        items: transfer.items.map((item) => ({
          productId: item.productId,
          productName: item.productName,
          productCode: item.productCode,
          isSerialized: item.isSerialized,
          quantity: item.quantity,
          packedQuantity: item.isSerialized ? item.serials.length : item.packedQuantity || 0,
        })),

        reason: transfer.reason,
        notes: transfer.notes,
        status: transfer.status,

        createdByName: transfer.createdByName,
        acceptedByName: transfer.acceptedByName,
        packedByName: transfer.packedByName,
        dispatchedByName: transfer.dispatchedByName,
        receivedByName: transfer.receivedByName,

        createdAt: transfer.createdAt,
        acceptedAt: transfer.acceptedAt,
        packedAt: transfer.packedAt,
        dispatchedAt: transfer.dispatchedAt,
        receivedAt: transfer.receivedAt,

        progress: {
          totalItems: transfer.items.length,
          totalQuantity,
          totalPacked,
          totalReceived,
          packedPercentage: totalQuantity > 0 ? Math.round((totalPacked / totalQuantity) * 100) : 0,
          receivedPercentage: totalPacked > 0 ? Math.round((totalReceived / totalPacked) * 100) : 0,
        },
      };
    });

    const statsFilter = { isDeleted: false };
    if (filter.$or) statsFilter.$or = filter.$or;
    if (filter.createdByBranchId) statsFilter.createdByBranchId = filter.createdByBranchId;
    if (filter.sourceBranchId) statsFilter.sourceBranchId = filter.sourceBranchId;

    const stats = {
      total: await Transfer.countDocuments(statsFilter),
      requested: await Transfer.countDocuments({ ...statsFilter, status: "REQUESTED" }),
      accepted: await Transfer.countDocuments({ ...statsFilter, status: "ACCEPTED" }),
      packed: await Transfer.countDocuments({ ...statsFilter, status: "PACKED" }),
      dispatched: await Transfer.countDocuments({ ...statsFilter, status: "DISPATCHED" }),
      completed: await Transfer.countDocuments({ ...statsFilter, status: { $in: ["COMPLETED", "RECEIVED"] } }),
      cancelled: await Transfer.countDocuments({ ...statsFilter, status: "CANCELLED" }),
    };

    return successResponse(res, "Transfers retrieved successfully", {
      transfers: transformedTransfers,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
      stats,
      filters: {
        search: search || "",
        status: status || "ALL",
        view: view || "ALL",
      },
    });
  } catch (error) {
    console.error("Get Pending Transfers Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve transfers", 500);
  }
};
