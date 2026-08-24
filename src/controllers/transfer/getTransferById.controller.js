// controllers/transfer/getTransferById.controller.js
import Transfer from "../../models/Transfer.modal.js";
import TransferHistory from "../../models/TransferHistory.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const getTransferByIdController = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const transfer = await Transfer.findById(id)
      .populate("sourceBranchId", "name code address phone")
      .populate("destinationBranchId", "name code address phone")
      .populate("createdBy", "name email")
      .populate("packedBy", "name email")
      .populate("dispatchedBy", "name email")
      .populate("receivedBy", "name email")
      .populate("cancelledBy", "name email")
      .lean();

    if (!transfer) {
      return errorResponse(res, "Transfer not found", 404);
    }

    // Access check - SUPER_ADMIN sees everything; BRANCH_ADMIN/STAFF may
    // only view a transfer that actually involves their own branch
    // (either side).
    const userBranchId = user?.branchId?.toString();
    const sourceBranchId = transfer.sourceBranchId?._id?.toString() || transfer.sourceBranchId?.toString();
    const destBranchId = transfer.destinationBranchId?._id?.toString() || transfer.destinationBranchId?.toString();

    if (user.role !== "SUPER_ADMIN") {
      if (userBranchId !== sourceBranchId && userBranchId !== destBranchId) {
        return errorResponse(res, "Access denied. You can only view transfers involving your branch.", 403);
      }
    }

    let totalDamaged = 0;
    let totalMissing = 0;
    for (const item of transfer.items) {
      if (item.isSerialized) {
        totalDamaged += item.serials?.filter((s) => s.condition === "DAMAGED").length || 0;
        totalMissing += item.serials?.filter((s) => s.condition === "MISSING").length || 0;
      } else {
        (item.sourceBatches || []).forEach((b) => {
          totalDamaged += b.receivedDamagedQuantity || 0;
          totalMissing += b.receivedMissingQuantity || 0;
        });
      }
    }

    const history = await TransferHistory.find({ transferId: transfer._id })
      .sort({ performedAt: -1 })
      .lean();

    const formattedTransfer = {
      _id: transfer._id,
      transferNumber: transfer.transferNumber,

      sourceBranch: transfer.sourceBranchId
        ? {
            _id: transfer.sourceBranchId._id,
            name: transfer.sourceBranchId.name,
            code: transfer.sourceBranchId.code,
            address: transfer.sourceBranchId.address,
            phone: transfer.sourceBranchId.phone,
          }
        : { name: transfer.sourceBranchName },
      sourceBranchName: transfer.sourceBranchName,

      destinationBranch: transfer.destinationBranchId
        ? {
            _id: transfer.destinationBranchId._id,
            name: transfer.destinationBranchId.name,
            code: transfer.destinationBranchId.code,
            address: transfer.destinationBranchId.address,
            phone: transfer.destinationBranchId.phone,
          }
        : { name: transfer.destinationBranchName },
      destinationBranchName: transfer.destinationBranchName,

      items: transfer.items.map((item) => ({
        productId: item.productId,
        productName: item.productName,
        productCode: item.productCode,
        isSerialized: item.isSerialized,
        quantity: item.quantity,
        serials: item.serials || [],
        sourceBatches: item.sourceBatches || [],
      })),

      summary: {
        ...transfer.summary,
        totalDamaged,
        totalMissing,
      },

      notes: transfer.notes,
      status: transfer.status,

      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
      packedAt: transfer.packedAt,
      dispatchedAt: transfer.dispatchedAt,
      receivedAt: transfer.receivedAt,
      cancelledAt: transfer.cancelledAt,

      createdBy: transfer.createdBy
        ? { _id: transfer.createdBy._id, name: transfer.createdBy.name, email: transfer.createdBy.email }
        : { name: transfer.createdByName },
      createdByName: transfer.createdByName,

      packedBy: transfer.packedBy
        ? { _id: transfer.packedBy._id, name: transfer.packedBy.name, email: transfer.packedBy.email }
        : null,
      packedByName: transfer.packedByName,

      dispatchedBy: transfer.dispatchedBy
        ? { _id: transfer.dispatchedBy._id, name: transfer.dispatchedBy.name, email: transfer.dispatchedBy.email }
        : null,
      dispatchedByName: transfer.dispatchedByName,

      receivedBy: transfer.receivedBy
        ? { _id: transfer.receivedBy._id, name: transfer.receivedBy.name, email: transfer.receivedBy.email }
        : null,
      receivedByName: transfer.receivedByName,

      cancelledBy: transfer.cancelledBy
        ? { _id: transfer.cancelledBy._id, name: transfer.cancelledBy.name, email: transfer.cancelledBy.email }
        : null,
      cancelledByName: transfer.cancelledByName,
      cancellationReason: transfer.cancellationReason,

      progress: {
        isProcessing: transfer.status === "PROCESSING",
        isPacked: transfer.status === "PACKED",
        isDispatched: transfer.status === "DISPATCHED",
        isReceived: transfer.status === "RECEIVED",
        isCancelled: transfer.status === "CANCELLED",
      },

      history: history.map((h) => ({
        _id: h._id,
        action: h.action,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        notes: h.notes,
        performedBy: h.performedBy,
        performedByName: h.performedByName,
        performedAt: h.performedAt,
        affectedItems: h.affectedItems || [],
      })),
    };

    return successResponse(res, "Transfer details retrieved successfully", formattedTransfer);
  } catch (error) {
    console.error("Get Transfer By ID Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve transfer details", 500);
  }
};
