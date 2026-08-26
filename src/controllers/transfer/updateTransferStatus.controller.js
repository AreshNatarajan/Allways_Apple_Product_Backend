// controllers/transfer/updateTransferStatus.controller.js
import mongoose from "mongoose";
import Transfer from "../../models/Transfer.modal.js";
import TransferHistory from "../../models/TransferHistory.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Every serial/batch was already reserved at creation
// (createTransfer.controller.js) - MARK_PACKED and DISPATCH are pure
// status flags with no further stock mutation, except DISPATCH also
// flips each already-RESERVED serial to IN_TRANSIT (a ProductSerial-
// level physical marker, not a separate Transfer-level stage - the
// Transfer's own status goes straight PACKED -> DISPATCHED -> RECEIVED).
// CANCEL (PROCESSING/PACKED only) reverses the reservation, since
// that's the only stock mutation that's happened by that point.
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
    // MARK_PACKED - Source Branch only. Pure status flag.
    // ============================================================
    if (action === "MARK_PACKED") {
      if (!isSuperAdmin && !isSourceBranchUser) {
        return rollback("Only the source branch can mark this transfer as packed", 403);
      }
      // Pack/Dispatch share one catalog permission (transfer.dispatch) -
      // defaults to true for BRANCH_ADMIN/STAFF today, can be revoked.
      if (!isSuperAdmin && user.permissions?.["transfer.dispatch"] !== true) {
        return rollback("You don't have permission to perform this action", 403);
      }
      if (transfer.status !== "PROCESSING") {
        return rollback(`Only PROCESSING transfers can be marked packed. Current: ${transfer.status}`, 400);
      }
      toStatus = "PACKED";
      historyAction = "PACKED";
      transfer.packedBy = user._id;
      transfer.packedByName = user.name;
      transfer.packedAt = new Date();
    }

    // ============================================================
    // DISPATCH - Source Branch only. Stock already left the branch's
    // available pool at creation (RESERVED / availableQuantity already
    // decremented) - this just flips each reserved serial to IN_TRANSIT
    // (assignedBranchId = destination, currentBranchId = null, i.e.
    // "physically on the way") and moves the Transfer to DISPATCHED.
    // ============================================================
    else if (action === "DISPATCH") {
      if (!isSuperAdmin && !isSourceBranchUser) {
        return rollback("Only the source branch can dispatch this transfer", 403);
      }
      if (!isSuperAdmin && user.permissions?.["transfer.dispatch"] !== true) {
        return rollback("You don't have permission to perform this action", 403);
      }
      if (transfer.status !== "PACKED") {
        return rollback(`Only PACKED transfers can be dispatched. Current: ${transfer.status}`, 400);
      }

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

      toStatus = "DISPATCHED";
      historyAction = "DISPATCHED";
      transfer.dispatchedBy = user._id;
      transfer.dispatchedByName = user.name;
      transfer.dispatchedAt = new Date();
    }

    // ============================================================
    // CANCEL - allowed only from PROCESSING or PACKED, i.e. before
    // DISPATCH. Reverses the reservation made at creation: serial
    // RESERVED -> AVAILABLE, batch availableQuantity restored. The
    // original TRANSFER_OUT StockMovement rows are immutable (append-
    // only ledger) - reversed the correct way, by writing new
    // offsetting ADJUSTMENT rows, never by editing/deleting the old ones.
    // ============================================================
    else if (action === "CANCEL") {
      const cancellableFrom = ["PROCESSING", "PACKED"];
      if (!cancellableFrom.includes(transfer.status)) {
        return rollback(`Only ${cancellableFrom.join("/")} transfers can be cancelled. Current: ${transfer.status}`, 400);
      }
      if (!isSuperAdmin && !isSourceBranchUser) {
        return rollback("Only the source branch can cancel this transfer", 403);
      }
      if (!isSuperAdmin && user.permissions?.["transfer.cancel"] !== true) {
        return rollback("You don't have permission to perform this action", 403);
      }

      for (const item of transfer.items) {
        if (item.isSerialized) {
          for (const s of item.serials) {
            const serialRecord = await ProductSerial.findById(s.productSerialId).session(session);
            if (serialRecord && serialRecord.status === "RESERVED") {
              serialRecord.status = "AVAILABLE";
              await serialRecord.save({ session });

              await recordStockMovement({
                type: "ADJUSTMENT",
                productId: serialRecord.productId,
                branchId: transfer.sourceBranchId,
                serialId: serialRecord._id,
                quantityDelta: 1,
                unitCost: serialRecord.purchasePrice,
                gstApplicable: serialRecord.gstApplicable,
                gstPercent: serialRecord.purchaseGstPercent,
                referenceType: "Transfer",
                referenceId: transfer._id,
                performedBy: user._id,
                performedByName: user.name || "",
                notes: `Serial ${serialRecord.serialNumber} reservation released - transfer ${transfer.transferNumber} cancelled`,
                session,
              });
            }
          }
        } else {
          for (const b of item.sourceBatches) {
            const batchStock = await BatchStock.findById(b.batchStockId).session(session);
            if (batchStock) {
              batchStock.availableQuantity += b.quantity;
              await batchStock.save({ session });

              await recordStockMovement({
                type: "ADJUSTMENT",
                productId: item.productId,
                branchId: transfer.sourceBranchId,
                batchId: batchStock.batchId,
                quantityDelta: b.quantity,
                resultingAvailableQuantity: batchStock.availableQuantity,
                unitCost: batchStock.purchasePrice,
                gstApplicable: batchStock.gstApplicable,
                gstPercent: batchStock.purchaseGstPercent,
                referenceType: "Transfer",
                referenceId: transfer._id,
                performedBy: user._id,
                performedByName: user.name || "",
                notes: `${b.quantity} unit(s) of batch ${b.batchNumber} reservation released - transfer ${transfer.transferNumber} cancelled`,
                session,
              });
            }
          }
        }
      }

      toStatus = "CANCELLED";
      historyAction = "CANCELLED";
      transfer.cancelledBy = user._id;
      transfer.cancelledByName = user.name;
      transfer.cancelledAt = new Date();
      transfer.cancellationReason = notes || "Cancelled by user";
    } else {
      return rollback(`Invalid action: ${action}. Allowed: MARK_PACKED, DISPATCH, CANCEL`, 400);
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
