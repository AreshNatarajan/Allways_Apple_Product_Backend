// controllers/transfer/packTransfer.controller.js
import mongoose from "mongoose";
import Transfer from "../../models/Transfer.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Inventory from "../../models/Inventory.modal.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const isFullyPacked = (item) =>
  item.isSerialized ? item.serials.length >= item.quantity : item.packedQuantity >= item.quantity;

// ============================================================
// Phase 2 - PACKING (Source Branch only)
// This is where physical verification actually begins - every serial/
// batch scanned here is validated against the real, current
// ProductSerial/BatchStock record, never against what was merely
// requested at Phase 1. Packing RESERVES stock immediately (source
// Inventory/BatchStock decreases, serials leave AVAILABLE) - dispatch
// itself moves no further quantity, only the physical status.
//
// Scanner and manual entry both call this exact same endpoint with the
// exact same payload shape - there is only one validation/mutation
// path, matching the pattern already established for Pending Receive.
// ============================================================
export const packTransferController = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  const rollback = async (message, statusCode = 400) => {
    await session.abortTransaction();
    session.endSession();
    return errorResponse(res, message, statusCode);
  };

  try {
    const { id } = req.params;
    const { items, notes } = req.body;
    const user = req.user;

    if (!mongoose.Types.ObjectId.isValid(id)) return rollback("Invalid transfer id", 400);
    if (!Array.isArray(items) || items.length === 0) return rollback("No items provided to pack", 400);

    const transfer = await Transfer.findById(id).session(session);
    if (!transfer) return rollback("Transfer not found", 404);
    if (transfer.isDeleted) return rollback("Transfer not found", 404);

    // Only the source branch (or SUPER_ADMIN) may pack.
    if (user.role !== "SUPER_ADMIN") {
      if (!user.branchId || user.branchId.toString() !== transfer.sourceBranchId.toString()) {
        return rollback("Only the source branch can pack this transfer", 403);
      }
    }

    // Packing is only meaningful once the source branch has accepted the
    // request - never allow updating an already-dispatched/completed/
    // cancelled transfer.
    if (transfer.status !== "ACCEPTED") {
      return rollback(`Cannot pack a transfer with status "${transfer.status}". Only ACCEPTED transfers can be packed.`, 400);
    }

    const errors = [];
    const packedSerialLog = [];
    const packedBatchLog = [];

    for (const rawItem of items) {
      const { isSerialized } = rawItem;

      // ============================================================
      // SERIALIZED - scan / manual serial entry
      // ============================================================
      if (isSerialized) {
        const serialNumber = (rawItem.serialNumber || "").trim().toUpperCase();
        if (!serialNumber) {
          errors.push("Serial number is required");
          continue;
        }

        const serialRecord = await ProductSerial.findOne({
          serialNumber,
          isDeleted: false,
        }).session(session);

        if (!serialRecord) {
          errors.push(`Serial "${serialNumber}" does not exist`);
          continue;
        }

        if (serialRecord.status !== "AVAILABLE") {
          errors.push(`Serial "${serialNumber}" is not AVAILABLE (current status: ${serialRecord.status})`);
          continue;
        }

        if (!serialRecord.currentBranchId || serialRecord.currentBranchId.toString() !== transfer.sourceBranchId.toString()) {
          errors.push(`Serial "${serialNumber}" does not belong to the source branch`);
          continue;
        }

        const item = transfer.items.find(
          (i) => i.isSerialized && i.productId.toString() === serialRecord.productId.toString()
        );
        if (!item) {
          errors.push(`Serial "${serialNumber}" does not match any product requested on this transfer`);
          continue;
        }

        if (item.serials.some((s) => s.serialNumber === serialNumber)) {
          errors.push(`Serial "${serialNumber}" has already been packed for this transfer`);
          continue;
        }

        if (item.serials.length >= item.quantity) {
          errors.push(`"${item.productName}": already packed the full requested quantity (${item.quantity})`);
          continue;
        }

        packedSerialLog.push({ item, serialRecord, serialNumber });
      } else {
        // ============================================================
        // NON-SERIALIZED - scan / manual batch entry + packed qty
        // ============================================================
        const batchNumber = (rawItem.batchNumber || "").trim().toUpperCase();
        const packedQty = Number(rawItem.packedQuantity) || 0;

        if (!batchNumber) {
          errors.push("Batch number is required");
          continue;
        }
        if (packedQty <= 0) {
          errors.push(`Packed quantity must be greater than 0 for batch "${batchNumber}"`);
          continue;
        }

        const batchStock = await BatchStock.findOne({
          batchNumber,
          branchId: transfer.sourceBranchId,
          status: "ACTIVE",
        }).session(session);

        if (!batchStock) {
          errors.push(`Batch "${batchNumber}" was not found (active) at the source branch`);
          continue;
        }

        const item = transfer.items.find(
          (i) => !i.isSerialized && i.productId.toString() === batchStock.productId.toString()
        );
        if (!item) {
          errors.push(`Batch "${batchNumber}" does not match any product requested on this transfer`);
          continue;
        }

        const remainingForItem = item.quantity - (item.packedQuantity || 0);
        if (packedQty > remainingForItem) {
          errors.push(`"${item.productName}": cannot pack ${packedQty} units, only ${remainingForItem} remaining of the requested quantity`);
          continue;
        }

        if (packedQty > batchStock.availableQuantity) {
          errors.push(`Batch "${batchNumber}" only has ${batchStock.availableQuantity} units available, cannot pack ${packedQty}`);
          continue;
        }

        packedBatchLog.push({ item, batchStock, packedQty });
      }
    }

    if (errors.length > 0) {
      return rollback(errors.join("\n"), 400);
    }

    // ============================================================
    // APPLY - serialized: RESERVE the serial
    // ============================================================
    const now = new Date();
    for (const { item, serialRecord, serialNumber } of packedSerialLog) {
      serialRecord.status = "RESERVED";
      await serialRecord.save({ session });

      item.serials.push({
        serialNumber,
        productSerialId: serialRecord._id,
        isPacked: true,
        packedAt: now,
      });

      // Legacy dual-write - mirrors receiveTransfer's symmetric +1 at the
      // destination, so Inventory.quantity for a serialized product stays
      // internally consistent across a transfer's whole lifecycle.
      await Inventory.findOneAndUpdate(
        { branchId: transfer.sourceBranchId, productId: serialRecord.productId },
        { $inc: { quantity: -1 } },
        { upsert: true, session }
      );

      await recordStockMovement({
        type: "TRANSFER_OUT",
        productId: serialRecord.productId,
        branchId: transfer.sourceBranchId,
        serialId: serialRecord._id,
        quantityDelta: -1,
        unitCost: serialRecord.purchasePrice,
        gstApplicable: serialRecord.gstApplicable,
        gstPercent: serialRecord.purchaseGstPercent,
        branchFrom: transfer.sourceBranchId,
        branchTo: transfer.destinationBranchId,
        referenceType: "Transfer",
        referenceId: transfer._id,
        performedBy: user._id,
        performedByName: user.name || "",
        notes: `Serial ${serialNumber} packed for transfer ${transfer.transferNumber} to ${transfer.destinationBranchName}`,
        session,
      });
    }

    // ============================================================
    // APPLY - non-serialized: RESERVE the packed quantity
    // ============================================================
    for (const { item, batchStock, packedQty } of packedBatchLog) {
      batchStock.availableQuantity -= packedQty;
      await batchStock.save({ session });

      await Inventory.findOneAndUpdate(
        { branchId: transfer.sourceBranchId, productId: item.productId },
        { $inc: { quantity: -packedQty } },
        { upsert: true, session }
      );

      item.packedQuantity = (item.packedQuantity || 0) + packedQty;
      const existingBatchEntry = item.packedBatches.find((b) => b.batchId?.toString() === batchStock.batchId.toString());
      if (existingBatchEntry) {
        existingBatchEntry.quantity += packedQty;
      } else {
        item.packedBatches.push({ batchId: batchStock.batchId, batchNumber: batchStock.batchNumber, quantity: packedQty });
      }

      await recordStockMovement({
        type: "TRANSFER_OUT",
        productId: item.productId,
        branchId: transfer.sourceBranchId,
        batchId: batchStock.batchId,
        quantityDelta: -packedQty,
        resultingAvailableQuantity: batchStock.availableQuantity,
        unitCost: batchStock.purchasePrice,
        gstApplicable: batchStock.gstApplicable,
        gstPercent: batchStock.purchaseGstPercent,
        branchFrom: transfer.sourceBranchId,
        branchTo: transfer.destinationBranchId,
        referenceType: "Transfer",
        referenceId: transfer._id,
        performedBy: user._id,
        performedByName: user.name || "",
        notes: `${packedQty} unit(s) of batch ${batchStock.batchNumber} packed for transfer ${transfer.transferNumber} to ${transfer.destinationBranchName}`,
        session,
      });
    }

    // ============================================================
    // NO AUTO STATUS TRANSITION. Reaching full packed quantity on every
    // item does NOT flip the transfer to PACKED by itself - the user
    // must explicitly review and confirm via the COMPLETE_PACKING
    // action (updateTransferStatus.ontroller.js). This call only ever
    // records packing progress; `readyToComplete` tells the frontend
    // when every item's target has been reached so it can enable the
    // "Complete Packing" button.
    // ============================================================
    const readyToComplete = transfer.items.every(isFullyPacked);

    await transfer.save({ session });

    // No TransferHistory row here - that ledger tracks status
    // transitions only (Created/Accepted/Packed/Dispatched/Received/
    // Cancelled, written by updateTransferStatus.ontroller.js). Every
    // individual scan's audit trail already lives in StockMovement via
    // recordStockMovement() above.

    await session.commitTransaction();
    session.endSession();

    const populatedTransfer = await Transfer.findById(transfer._id)
      .populate("sourceBranchId", "name code")
      .populate("destinationBranchId", "name code");

    return successResponse(res, readyToComplete ? "All items packed - ready to complete packing" : "Items packed successfully", {
      transfer: populatedTransfer,
      summary: {
        totalSerialsPacked: packedSerialLog.length,
        totalBatchesPacked: packedBatchLog.length,
        readyToComplete,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Pack Transfer Error:", error);
    if (error.code === 11000) {
      return errorResponse(res, "This item has already been recorded for this transfer. Please refresh and try again.", 409);
    }
    return errorResponse(res, error.message || "Failed to pack transfer", 500);
  }
};
