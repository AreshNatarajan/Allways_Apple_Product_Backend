// controllers/transfer/receiveTransfer.controller.js
import mongoose from "mongoose";
import Transfer from "../../models/Transfer.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Batch from "../../models/Batch.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Inventory from "../../models/Inventory.modal.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const VALID_CONDITIONS = ["GOOD", "DAMAGED", "MISSING"];

const isFullyReceived = (item) => {
  if (item.isSerialized) {
    return item.serials.every((s) => s.condition !== null);
  }
  return item.packedBatches.every((b) => b.receivedQuantity + b.damagedQuantity + b.missingQuantity >= b.quantity);
};

// ============================================================
// Phase 3 - RECEIVE (Destination Branch only)
// The destination can never edit the request itself - this only ever
// processes what was actually packed and dispatched (item.serials[] /
// item.packedBatches[]), never the original Phase 1 quantity. Only
// GOOD quantity ever increases sellable inventory - Damaged and
// Missing are recorded but never touch BatchStock.availableQuantity/
// Inventory.quantity, matching the exact convention already
// established by the Pending Receive module.
// ============================================================
export const receiveTransferController = async (req, res) => {
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
    if (!Array.isArray(items) || items.length === 0) return rollback("No items provided to receive", 400);

    const transfer = await Transfer.findById(id).session(session);
    if (!transfer) return rollback("Transfer not found", 404);
    if (transfer.isDeleted) return rollback("Transfer not found", 404);

    if (user.role !== "SUPER_ADMIN") {
      if (!user.branchId || user.branchId.toString() !== transfer.destinationBranchId.toString()) {
        return rollback("Only the destination branch can receive this transfer", 403);
      }
    }

    if (transfer.status !== "DISPATCHED") {
      return rollback(`Cannot receive a transfer with status "${transfer.status}". Only DISPATCHED transfers can be received.`, 400);
    }

    const errors = [];
    const serialReceiveLog = [];
    const batchReceiveLog = [];

    for (const rawItem of items) {
      if (rawItem.isSerialized) {
        const serialNumber = (rawItem.serialNumber || "").trim().toUpperCase();
        const condition = (rawItem.condition || "").toUpperCase();
        const remarks = rawItem.remarks || "";

        if (!serialNumber) {
          errors.push("Serial number is required");
          continue;
        }
        if (!VALID_CONDITIONS.includes(condition)) {
          errors.push(`Serial "${serialNumber}": condition must be GOOD, DAMAGED, or MISSING`);
          continue;
        }
        if (condition !== "GOOD" && !remarks.trim()) {
          errors.push(`Serial "${serialNumber}": remarks are required when marking ${condition}`);
          continue;
        }

        const item = transfer.items.find((i) => i.isSerialized && i.serials.some((s) => s.serialNumber === serialNumber));
        const packedEntry = item?.serials.find((s) => s.serialNumber === serialNumber);

        if (!item || !packedEntry) {
          errors.push(`Serial "${serialNumber}" was not part of this transfer's dispatch`);
          continue;
        }
        if (packedEntry.condition !== null) {
          errors.push(`Serial "${serialNumber}" has already been received`);
          continue;
        }

        const serialRecord = await ProductSerial.findById(packedEntry.productSerialId).session(session);
        if (!serialRecord) {
          errors.push(`Serial "${serialNumber}" record could not be found`);
          continue;
        }
        if (serialRecord.status !== "IN_TRANSIT") {
          errors.push(`Serial "${serialNumber}" is not in transit (current status: ${serialRecord.status})`);
          continue;
        }
        if (!serialRecord.assignedBranchId || serialRecord.assignedBranchId.toString() !== transfer.destinationBranchId.toString()) {
          errors.push(`Serial "${serialNumber}" is not assigned to this destination branch`);
          continue;
        }

        serialReceiveLog.push({ item, packedEntry, serialRecord, condition, remarks });
      } else {
        const batchNumber = (rawItem.batchNumber || "").trim().toUpperCase();
        const goodQty = Number(rawItem.goodQuantity) || 0;
        const damagedQty = Number(rawItem.damagedQuantity) || 0;
        const missingQty = Number(rawItem.missingQuantity) || 0;
        const remarks = rawItem.remarks || "";
        const total = goodQty + damagedQty + missingQty;

        if (!batchNumber) {
          errors.push("Batch number is required");
          continue;
        }
        if (total <= 0) {
          errors.push(`Batch "${batchNumber}": arrived quantity must be greater than 0`);
          continue;
        }
        if ((damagedQty > 0 || missingQty > 0) && !remarks.trim()) {
          errors.push(`Batch "${batchNumber}": remarks are required when reporting damaged/missing units`);
          continue;
        }

        const item = transfer.items.find(
          (i) => !i.isSerialized && i.packedBatches.some((b) => b.batchNumber === batchNumber)
        );
        const packedBatch = item?.packedBatches.find((b) => b.batchNumber === batchNumber);

        if (!item || !packedBatch) {
          errors.push(`Batch "${batchNumber}" was not part of this transfer's dispatch`);
          continue;
        }

        const alreadyProcessed = packedBatch.receivedQuantity + packedBatch.damagedQuantity + packedBatch.missingQuantity;
        const remaining = packedBatch.quantity - alreadyProcessed;
        if (total > remaining) {
          errors.push(`Batch "${batchNumber}": cannot process ${total} units, only ${remaining} remaining of the packed quantity`);
          continue;
        }

        batchReceiveLog.push({ item, packedBatch, goodQty, damagedQty, missingQty, remarks });
      }
    }

    if (errors.length > 0) {
      return rollback(errors.join("\n"), 400);
    }

    const now = new Date();

    // ============================================================
    // APPLY - serialized
    // ============================================================
    for (const { item, packedEntry, serialRecord, condition, remarks } of serialReceiveLog) {
      if (condition === "GOOD") {
        serialRecord.status = "AVAILABLE";
        serialRecord.currentBranchId = transfer.destinationBranchId;
        serialRecord.assignedBranchId = null;
        serialRecord.receivedAt = now;
      } else {
        serialRecord.status = condition; // DAMAGED | MISSING
        serialRecord.currentBranchId = transfer.destinationBranchId;
        serialRecord.assignedBranchId = null;
        serialRecord.remarks = remarks;
        serialRecord.conditionUpdatedBy = user._id;
        serialRecord.conditionUpdatedAt = now;
      }
      await serialRecord.save({ session });

      packedEntry.condition = condition;
      packedEntry.remarks = remarks;
      packedEntry.isReceived = condition === "GOOD";
      packedEntry.isRejected = condition !== "GOOD";

      if (condition === "GOOD") {
        item.receivedQuantity = (item.receivedQuantity || 0) + 1;
        await Inventory.findOneAndUpdate(
          { branchId: transfer.destinationBranchId, productId: serialRecord.productId },
          { $inc: { quantity: 1 } },
          { upsert: true, session }
        );
        await recordStockMovement({
          type: "TRANSFER_IN",
          productId: serialRecord.productId,
          branchId: transfer.destinationBranchId,
          serialId: serialRecord._id,
          quantityDelta: 1,
          unitCost: serialRecord.purchasePrice,
          gstApplicable: serialRecord.gstApplicable,
          gstPercent: serialRecord.purchaseGstPercent,
          branchFrom: transfer.sourceBranchId,
          branchTo: transfer.destinationBranchId,
          referenceType: "Transfer",
          referenceId: transfer._id,
          performedBy: user._id,
          performedByName: user.name || "",
          notes: `Serial ${packedEntry.serialNumber} received at ${transfer.destinationBranchName} (transfer ${transfer.transferNumber})`,
          session,
        });
      } else if (condition === "DAMAGED") {
        item.damagedQuantity = (item.damagedQuantity || 0) + 1;
      } else {
        item.missingQuantity = (item.missingQuantity || 0) + 1;
      }
    }

    // ============================================================
    // APPLY - non-serialized
    // ============================================================
    for (const { item, packedBatch, goodQty, damagedQty, missingQty, remarks } of batchReceiveLog) {
      packedBatch.receivedQuantity += goodQty;
      packedBatch.damagedQuantity += damagedQty;
      packedBatch.missingQuantity += missingQty;

      item.receivedQuantity = (item.receivedQuantity || 0) + goodQty;
      item.damagedQuantity = (item.damagedQuantity || 0) + damagedQty;
      item.missingQuantity = (item.missingQuantity || 0) + missingQty;
      if (remarks) item.remarks = remarks;

      if (goodQty + damagedQty > 0) {
        const batch = await Batch.findById(packedBatch.batchId).session(session);
        if (batch) {
          let destBatchStock = await BatchStock.findOne({
            batchId: batch._id,
            branchId: transfer.destinationBranchId,
          }).session(session);

          if (destBatchStock) {
            destBatchStock.quantity += goodQty + damagedQty;
            destBatchStock.availableQuantity += goodQty;
            destBatchStock.damagedQuantity += damagedQty;
            await destBatchStock.save({ session });
          } else {
            destBatchStock = new BatchStock({
              batchId: batch._id,
              productId: item.productId,
              branchId: transfer.destinationBranchId,
              batchNumber: batch.batchNumber,
              barcode: batch.batchNumber,
              productCode: item.productCode || "",
              purchaseId: batch.purchaseId,
              quantity: goodQty + damagedQty,
              availableQuantity: goodQty,
              damagedQuantity: damagedQty,
              soldQuantity: 0,
              purchasePrice: batch.purchasePrice,
              sellingPrice: batch.sellingPrice,
              gstApplicable: batch.gstApplicable,
              purchaseGstPercent: batch.purchaseGstPercent,
              status: "ACTIVE",
            });
            await destBatchStock.save({ session });
          }

          if (goodQty > 0) {
            await Inventory.findOneAndUpdate(
              { branchId: transfer.destinationBranchId, productId: item.productId },
              { $inc: { quantity: goodQty } },
              { upsert: true, session }
            );

            await recordStockMovement({
              type: "TRANSFER_IN",
              productId: item.productId,
              branchId: transfer.destinationBranchId,
              batchId: batch._id,
              quantityDelta: goodQty,
              resultingAvailableQuantity: destBatchStock.availableQuantity,
              unitCost: batch.purchasePrice,
              gstApplicable: batch.gstApplicable,
              gstPercent: batch.purchaseGstPercent,
              branchFrom: transfer.sourceBranchId,
              branchTo: transfer.destinationBranchId,
              referenceType: "Transfer",
              referenceId: transfer._id,
              performedBy: user._id,
              performedByName: user.name || "",
              notes: `${goodQty} unit(s) of batch ${batch.batchNumber} received at ${transfer.destinationBranchName} (transfer ${transfer.transferNumber})`,
              session,
            });
          }
        }
      }
    }

    // ============================================================
    // NO AUTO STATUS TRANSITION. Reaching full accounting (every
    // dispatched serial/batch unit marked GOOD/DAMAGED/MISSING) does
    // NOT flip the transfer to COMPLETED by itself - the user must
    // explicitly review and confirm via the COMPLETE_RECEIVING action
    // (updateTransferStatus.ontroller.js). `readyToComplete` tells the
    // frontend when that button can be enabled. No TransferHistory row
    // here either - see the equivalent note in packTransfer.controller.js;
    // every individual scan's audit trail already lives in StockMovement.
    // ============================================================
    const readyToComplete = transfer.items.every(isFullyReceived);

    await transfer.save({ session });

    await session.commitTransaction();
    session.endSession();

    const populatedTransfer = await Transfer.findById(transfer._id)
      .populate("sourceBranchId", "name code")
      .populate("destinationBranchId", "name code");

    return successResponse(res, readyToComplete ? "All items accounted for - ready to complete receiving" : "Items received successfully", {
      transfer: populatedTransfer,
      summary: {
        totalSerialsReceived: serialReceiveLog.length,
        totalBatchesProcessed: batchReceiveLog.length,
        readyToComplete,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Receive Transfer Error:", error);
    if (error.code === 11000) {
      return errorResponse(res, "This item has already been recorded for this transfer. Please refresh and try again.", 409);
    }
    return errorResponse(res, error.message || "Failed to receive transfer", 500);
  }
};
