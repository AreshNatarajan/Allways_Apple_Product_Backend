// controllers/transfer/updateTransferStatus.controller.js
import mongoose from "mongoose";
import Transfer from "../../models/Transfer.modal.js";
import TransferHistory from "../../models/TransferHistory.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Inventory from "../../models/Inventory.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const isFullyPacked = (item) =>
  item.isSerialized ? item.serials.length >= item.quantity : (item.packedQuantity || 0) >= item.quantity;

const isFullyReceived = (item) => {
  if (item.isSerialized) {
    return item.serials.every((s) => s.condition !== null);
  }
  return item.packedBatches.every((b) => b.receivedQuantity + b.damagedQuantity + b.missingQuantity >= b.quantity);
};

// Simple status-flip actions only - ACCEPT, DISPATCH, CANCEL,
// COMPLETE_PACKING, COMPLETE_RECEIVING. Nothing here ever scans/
// validates an individual serial or batch; that level of physical
// verification lives in packTransfer.controller.js (Phase 2) and
// receiveTransfer.controller.js (Phase 3) - those two only ever record
// progress and never flip status themselves. COMPLETE_PACKING/
// COMPLETE_RECEIVING are the explicit, user-initiated confirmation
// step that actually commits ACCEPTED->PACKED / DISPATCHED->COMPLETED,
// so a transfer never becomes PACKED or COMPLETED merely because a
// scan happened to reach the full requested quantity.
export const updateTransferStatusController = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  const rollback = async (message, statusCode = 400) => {
    await session.abortTransaction();
    session.endSession();
    return errorResponse(res, message, statusCode);
  };

  try {
    const { id } = req.params;
    const { action, notes } = req.body;
    const user = req.user;

    if (!mongoose.Types.ObjectId.isValid(id)) return rollback("Invalid transfer id", 400);

    const transfer = await Transfer.findById(id).session(session);
    if (!transfer) return rollback("Transfer not found", 404);
    if (transfer.isDeleted) return rollback("Transfer not found", 404);

    const isSuperAdmin = user.role === "SUPER_ADMIN";
    const isSourceBranchUser = !!user.branchId && user.branchId.toString() === transfer.sourceBranchId.toString();

    let fromStatus = transfer.status;
    let toStatus = transfer.status;
    let historyAction = "";

    // ============================================================
    // ACCEPT - Source Branch only
    // ============================================================
    if (action === "ACCEPT") {
      if (!isSuperAdmin && !isSourceBranchUser) {
        return rollback("Only the source branch can accept this transfer request", 403);
      }
      if (transfer.status !== "REQUESTED") {
        return rollback(`Only REQUESTED transfers can be accepted. Current: ${transfer.status}`, 400);
      }
      toStatus = "ACCEPTED";
      historyAction = "ACCEPTED";
      transfer.acceptedBy = user._id;
      transfer.acceptedByName = user.name;
      transfer.acceptedAt = new Date();
    }

    // ============================================================
    // DISPATCH - Source Branch only. Requires PACKED (every requested
    // item physically verified and reserved during Phase 2) - dispatch
    // itself moves no further quantity, it only flips each packed
    // serial's status from RESERVED to IN_TRANSIT ("Still Reserved").
    // ============================================================
    else if (action === "DISPATCH") {
      if (!isSuperAdmin && !isSourceBranchUser) {
        return rollback("Only the source branch can dispatch this transfer", 403);
      }
      if (transfer.status !== "PACKED") {
        return rollback(
          `Only PACKED transfers can be dispatched. Current: ${transfer.status}. Pack every requested item first.`,
          400
        );
      }
      toStatus = "DISPATCHED";
      historyAction = "DISPATCHED";
      transfer.dispatchedBy = user._id;
      transfer.dispatchedByName = user.name;
      transfer.dispatchedAt = new Date();

      for (const item of transfer.items) {
        if (!item.isSerialized) continue;
        for (const s of item.serials) {
          const serialRecord = await ProductSerial.findById(s.productSerialId).session(session);
          if (serialRecord && serialRecord.status === "RESERVED") {
            serialRecord.status = "IN_TRANSIT";
            serialRecord.currentBranchId = null;
            serialRecord.assignedBranchId = transfer.destinationBranchId;
            serialRecord.transferredAt = new Date();
            await serialRecord.save({ session });
          }
        }
      }
    }

    // ============================================================
    // COMPLETE_PACKING - Source Branch only. The explicit confirmation
    // step packTransfer.controller.js no longer performs automatically -
    // requires every item to have actually reached its full requested
    // quantity first (re-checked here, never trusted from the client).
    // ============================================================
    else if (action === "COMPLETE_PACKING") {
      if (!isSuperAdmin && !isSourceBranchUser) {
        return rollback("Only the source branch can complete packing for this transfer", 403);
      }
      if (transfer.status !== "ACCEPTED") {
        return rollback(`Only ACCEPTED transfers can complete packing. Current: ${transfer.status}`, 400);
      }
      const remaining = transfer.items.filter((item) => !isFullyPacked(item));
      if (remaining.length > 0) {
        const detail = remaining
          .map((item) => `"${item.productName}": ${item.isSerialized ? item.serials.length : item.packedQuantity || 0}/${item.quantity} packed`)
          .join(", ");
        return rollback(`Not every item is fully packed yet - ${detail}`, 400);
      }
      toStatus = "PACKED";
      historyAction = "PACKED";
      transfer.packedBy = user._id;
      transfer.packedByName = user.name;
      transfer.packedAt = new Date();
    }

    // ============================================================
    // COMPLETE_RECEIVING - Destination Branch only. The explicit
    // confirmation step receiveTransfer.controller.js no longer
    // performs automatically - requires every item to be fully
    // accounted for (GOOD + DAMAGED + MISSING covering the full packed
    // quantity) first, re-checked here, never trusted from the client.
    // ============================================================
    else if (action === "COMPLETE_RECEIVING") {
      const isDestinationBranchUser = !!user.branchId && user.branchId.toString() === transfer.destinationBranchId.toString();
      if (!isSuperAdmin && !isDestinationBranchUser) {
        return rollback("Only the destination branch can complete receiving for this transfer", 403);
      }
      if (transfer.status !== "DISPATCHED") {
        return rollback(`Only DISPATCHED transfers can complete receiving. Current: ${transfer.status}`, 400);
      }
      const remaining = transfer.items.filter((item) => !isFullyReceived(item));
      if (remaining.length > 0) {
        return rollback(`Not every item has been fully accounted for yet - ${remaining.map((i) => `"${i.productName}"`).join(", ")} still needs GOOD/DAMAGED/MISSING recorded for its full packed quantity`, 400);
      }
      toStatus = "COMPLETED";
      historyAction = "RECEIVED";
      transfer.receivedBy = user._id;
      transfer.receivedByName = user.name;
      transfer.receivedAt = new Date();
    }

    // ============================================================
    // CANCEL - allowed from REQUESTED/ACCEPTED/PACKED/DISPATCHED.
    // Once real stock has been reserved (PACKED or later), only the
    // source branch can cancel, since only they can safely reverse it;
    // a plain REQUESTED/ACCEPTED cancellation never touched stock, so
    // either side may cancel it.
    // ============================================================
    else if (action === "CANCEL") {
      const cancellableFrom = ["REQUESTED", "ACCEPTED", "PACKED", "DISPATCHED"];
      if (!cancellableFrom.includes(transfer.status)) {
        return rollback(
          `Only ${cancellableFrom.join(", ")} transfers can be cancelled. Current: ${transfer.status}`,
          400
        );
      }
      if (["PACKED", "DISPATCHED"].includes(transfer.status) && !isSuperAdmin && !isSourceBranchUser) {
        return rollback("Only the source branch can cancel a transfer that has already been packed or dispatched", 403);
      }

      toStatus = "CANCELLED";
      historyAction = "CANCELLED";
      transfer.cancelledBy = user._id;
      transfer.cancelledByName = user.name;
      transfer.cancelledAt = new Date();
      transfer.cancellationReason = notes || "Cancelled by user";

      // Restore whatever was reserved/in-transit back to the source
      // branch - covers both PACKED (never left the building) and
      // DISPATCHED (physically in transit, called back) alike.
      if (["PACKED", "DISPATCHED"].includes(fromStatus)) {
        for (const item of transfer.items) {
          if (item.isSerialized) {
            for (const s of item.serials) {
              const serialRecord = await ProductSerial.findById(s.productSerialId).session(session);
              if (serialRecord && ["RESERVED", "IN_TRANSIT"].includes(serialRecord.status)) {
                serialRecord.status = "AVAILABLE";
                serialRecord.currentBranchId = transfer.sourceBranchId;
                serialRecord.assignedBranchId = null;
                await serialRecord.save({ session });

                await Inventory.findOneAndUpdate(
                  { branchId: transfer.sourceBranchId, productId: serialRecord.productId },
                  { $inc: { quantity: 1 } },
                  { upsert: true, session }
                );
              }
            }
          } else {
            for (const packedBatch of item.packedBatches) {
              const stillReserved = packedBatch.quantity - packedBatch.receivedQuantity - packedBatch.damagedQuantity - packedBatch.missingQuantity;
              if (stillReserved <= 0) continue;

              const batchStock = await BatchStock.findOne({
                batchId: packedBatch.batchId,
                branchId: transfer.sourceBranchId,
              }).session(session);
              if (batchStock) {
                batchStock.availableQuantity += stillReserved;
                await batchStock.save({ session });
              }

              await Inventory.findOneAndUpdate(
                { branchId: transfer.sourceBranchId, productId: item.productId },
                { $inc: { quantity: stillReserved } },
                { upsert: true, session }
              );
            }
          }
        }
      }
    }

    // ============================================================
    // INVALID ACTION
    // ============================================================
    else {
      return rollback(`Invalid action: ${action}. Allowed: ACCEPT, COMPLETE_PACKING, DISPATCH, COMPLETE_RECEIVING, CANCEL`, 400);
    }

    transfer.status = toStatus;
    await transfer.save({ session });

    await TransferHistory.create(
      [
        {
          transferId: transfer._id,
          transferNumber: transfer.transferNumber,
          action: historyAction,
          fromStatus,
          toStatus,
          notes: notes || `Transfer ${historyAction.toLowerCase()} by ${user.name}`,
          performedBy: user._id,
          performedByName: user.name,
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    const populatedTransfer = await Transfer.findById(transfer._id)
      .populate("sourceBranchId", "name code")
      .populate("destinationBranchId", "name code")
      .populate("createdBy", "name email")
      .populate("acceptedBy", "name email")
      .populate("packedBy", "name email")
      .populate("dispatchedBy", "name email")
      .populate("receivedBy", "name email")
      .populate("cancelledBy", "name email");

    return successResponse(res, `Transfer ${historyAction.toLowerCase()} successfully`, {
      transfer: populatedTransfer,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Update Transfer Status Error:", error);
    if (error.code === 11000) {
      return errorResponse(res, "This action has already been recorded for this transfer. Please refresh and try again.", 409);
    }
    return errorResponse(res, error.message || "Failed to update transfer status", 500);
  }
};
