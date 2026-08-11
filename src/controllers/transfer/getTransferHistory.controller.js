// controllers/transfer/getTransferHistory.controller.js
import mongoose from "mongoose";
import Transfer from "../../models/Transfer.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Completed transfer history - COMPLETED (the resting status for a
// fully received transfer, see receiveTransfer.controller.js) and
// CANCELLED. RECEIVED is matched too purely for backward compatibility
// with any transfer that predates the COMPLETED status.
const HISTORY_STATUSES = ["COMPLETED", "RECEIVED", "CANCELLED"];

export const getTransferHistoryController = async (req, res) => {
  try {
    const user = req.user;
    const { page = 1, limit = 10, search = "", status = "ALL" } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {
      isDeleted: false,
      status: { $in: HISTORY_STATUSES },
    };

    // BRANCH_ADMIN/STAFF are always force-scoped to their own branch
    // (either side of the transfer) - inline, never via the shared
    // getBranchFilter helper (known gap: returns {} unscoped for STAFF).
    if (user.role !== "SUPER_ADMIN") {
      if (!user.branchId) return errorResponse(res, "Branch not assigned to user", 400);
      const branchId = new mongoose.Types.ObjectId(user.branchId);
      filter.$or = [{ sourceBranchId: branchId }, { destinationBranchId: branchId }];
    }

    if (status && status !== "ALL") {
      filter.status = status;
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
      .populate("cancelledBy", "name email")
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Transfer.countDocuments(filter);

    const transformedTransfers = transfers.map((transfer) => ({
      _id: transfer._id,
      transferNumber: transfer.transferNumber,
      sourceBranchName: transfer.sourceBranchName,
      destinationBranchName: transfer.destinationBranchName,
      items: transfer.items.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        productCode: item.productCode,
        isSerialized: item.isSerialized,
        quantity: item.quantity,
        packedQuantity: item.isSerialized ? item.serials.length : item.packedQuantity || 0,
        receivedQuantity: item.receivedQuantity || 0,
        damagedQuantity: item.damagedQuantity || 0,
        missingQuantity: item.missingQuantity || 0,
      })),
      summary: transfer.summary,
      reason: transfer.reason,
      notes: transfer.notes,
      status: transfer.status,

      createdByName: transfer.createdByName,
      acceptedByName: transfer.acceptedByName,
      packedByName: transfer.packedByName,
      dispatchedByName: transfer.dispatchedByName,
      receivedByName: transfer.receivedByName,
      cancelledByName: transfer.cancelledByName,

      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
      acceptedAt: transfer.acceptedAt,
      packedAt: transfer.packedAt,
      dispatchedAt: transfer.dispatchedAt,
      receivedAt: transfer.receivedAt,
      cancelledAt: transfer.cancelledAt,

      completionSummary: {
        totalItems: transfer.items.length,
        totalQuantity: transfer.items.reduce((sum, item) => sum + item.quantity, 0),
        totalReceived: transfer.summary?.totalReceived || 0,
        totalDamaged: transfer.summary?.totalDamaged || 0,
        totalMissing: transfer.summary?.totalMissing || 0,
      },
    }));

    const statsFilter = { isDeleted: false, status: { $in: HISTORY_STATUSES } };
    if (filter.$or) statsFilter.$or = filter.$or;

    const stats = {
      total: await Transfer.countDocuments(statsFilter),
      completed: await Transfer.countDocuments({ ...statsFilter, status: { $in: ["COMPLETED", "RECEIVED"] } }),
      cancelled: await Transfer.countDocuments({ ...statsFilter, status: "CANCELLED" }),
    };

    return successResponse(res, "Transfer history retrieved successfully", {
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
      },
    });
  } catch (error) {
    console.error("Get Transfer History Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve transfer history", 500);
  }
};
