// controllers/transfer/getTransferHistoryById.controller.js
import Transfer from "../../models/Transfer.modal.js";
import TransferHistory from "../../models/TransferHistory.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const getTransferHistoryByIdController = async (req, res) => {
  try {
    const { id } = req.params; // Transfer ID
    const user = req.user;

    // Same branch-involvement access rule as getTransferById - this
    // previously had no authorization check at all, letting any
    // authenticated user pull any transfer's timeline by guessing an id.
    const transfer = await Transfer.findById(id).select("sourceBranchId destinationBranchId").lean();
    if (!transfer) {
      return errorResponse(res, "Transfer not found", 404);
    }
    if (user.role !== "SUPER_ADMIN") {
      const userBranchId = user?.branchId?.toString();
      if (userBranchId !== transfer.sourceBranchId?.toString() && userBranchId !== transfer.destinationBranchId?.toString()) {
        return errorResponse(res, "Access denied. You can only view transfers involving your branch.", 403);
      }
    }

    const history = await TransferHistory.find({ transferId: id })
      .sort({ performedAt: 1 }) // Oldest to newest
      .lean();

    if (!history || history.length === 0) {
      return successResponse(res, "No history found for this transfer", []);
    }

    const formattedHistory = history.map((record) => ({
      _id: record._id,
      action: record.action,
      fromStatus: record.fromStatus,
      toStatus: record.toStatus,
      notes: record.notes,
      performedBy: record.performedBy,
      performedByName: record.performedByName,
      performedAt: record.performedAt,
      affectedItems: record.affectedItems || [],
      createdAt: record.createdAt,
      actionLabel: getActionLabel(record.action),
    }));

    const timelineStats = {
      totalActions: history.length,
      firstAction: history[0]?.performedAt || null,
      lastAction: history[history.length - 1]?.performedAt || null,
      actions: {
        created: history.filter((h) => h.action === "CREATED").length,
        packed: history.filter((h) => h.action === "PACKED").length,
        dispatched: history.filter((h) => h.action === "DISPATCHED").length,
        received: history.filter((h) => h.action === "RECEIVED").length,
        cancelled: history.filter((h) => h.action === "CANCELLED").length,
        deleted: history.filter((h) => h.action === "DELETED").length,
      },
    };

    return successResponse(res, "Transfer history retrieved successfully", {
      transferId: id,
      history: formattedHistory,
      timelineStats,
    });
  } catch (error) {
    console.error("Get Transfer History By ID Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve transfer history", 500);
  }
};

const getActionLabel = (action) => {
  const labels = {
    CREATED: "Created",
    PACKED: "Packed",
    DISPATCHED: "Dispatched",
    RECEIVED: "Received",
    CANCELLED: "Cancelled",
    DELETED: "Deleted",
  };
  return labels[action] || action;
};
