// controllers/transfer/receiveTransfer.controller.js
import mongoose from "mongoose";
import Transfer from "../../models/Transfer.modal.js";
import TransferHistory from "../../models/TransferHistory.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const VALID_CONDITIONS = ["GOOD", "DAMAGED", "MISSING"];

// ============================================================
// RECEIVE - Destination Branch only, single-shot (no scanning, no
// incremental partial receives - the whole transfer is confirmed in
// one call). Every serial/batch was already fixed (and reserved) at
// creation, so this only ever reviews and records condition, never
// re-selects items. Only GOOD ever credits sellable inventory -
// DAMAGED/MISSING are recorded but never touch
// BatchStock.availableQuantity, matching the exact convention already
// established by the Pending Receive module. `transfer.status !==
// DISPATCHED` (i.e. already RECEIVED, or not dispatched yet) is itself
// the duplicate-receive guard.
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
    const { serialResults = [], batchResults = [], notes } = req.body;
    const user = req.user;

    if (!mongoose.Types.ObjectId.isValid(id)) return rollback("Invalid transfer id", 400);

    const transfer = await Transfer.findById(id).session(session);
    if (!transfer) return rollback("Transfer not found", 404);
    if (transfer.isDeleted) return rollback("Transfer not found", 404);

    if (user.role !== "SUPER_ADMIN") {
      if (!user.branchId || user.branchId.toString() !== transfer.destinationBranchId.toString()) {
        return rollback("Only the destination branch can receive this transfer", 403);
      }
      // transfer.receive per-user grant (defaults to true for
      // BRANCH_ADMIN/STAFF today, can be revoked) - see config/permissionCatalog.js.
      if (user.permissions?.["transfer.receive"] !== true) {
        return rollback("You don't have permission to perform this action", 403);
      }
    }

    if (transfer.status !== "DISPATCHED") {
      return rollback(
        transfer.status === "RECEIVED"
          ? "This transfer has already been received."
          : `Cannot receive a transfer with status "${transfer.status}". Only DISPATCHED transfers can be received.`,
        400
      );
    }

    const serialResultByPsId = new Map(serialResults.map((r) => [String(r.productSerialId), r]));
    const batchResultByBsId = new Map(batchResults.map((r) => [String(r.batchStockId), r]));

    const errors = [];
    const serialLog = [];
    const batchLog = [];

    for (const item of transfer.items) {
      if (item.isSerialized) {
        for (const s of item.serials) {
          const result = serialResultByPsId.get(String(s.productSerialId));
          const condition = (result?.condition || "GOOD").toUpperCase();
          const remarks = result?.remarks || "";

          if (!VALID_CONDITIONS.includes(condition)) {
            errors.push(`Serial "${s.serialNumber}": condition must be GOOD, DAMAGED, or MISSING`);
            continue;
          }
          if (condition !== "GOOD" && !remarks.trim()) {
            errors.push(`Serial "${s.serialNumber}": remarks are required when marking ${condition}`);
            continue;
          }

          const serialRecord = await ProductSerial.findById(s.productSerialId).session(session);
          if (!serialRecord) {
            errors.push(`Serial "${s.serialNumber}" record could not be found`);
            continue;
          }
          if (serialRecord.status !== "IN_TRANSIT" || serialRecord.assignedBranchId?.toString() !== transfer.destinationBranchId.toString()) {
            errors.push(`Serial "${s.serialNumber}" is not in transit to this branch (current status: ${serialRecord.status})`);
            continue;
          }

          serialLog.push({ item, itemSerial: s, serialRecord, condition, remarks });
        }
      } else {
        for (const b of item.sourceBatches) {
          const result = batchResultByBsId.get(String(b.batchStockId));
          const goodQty = result ? Number(result.goodQuantity) || 0 : b.quantity;
          const damagedQty = result ? Number(result.damagedQuantity) || 0 : 0;
          const missingQty = result ? Number(result.missingQuantity) || 0 : 0;
          const remarks = result?.remarks || "";
          const total = goodQty + damagedQty + missingQty;

          if (total !== b.quantity) {
            errors.push(`Batch "${b.batchNumber}": good+damaged+missing must total exactly ${b.quantity} (got ${total})`);
            continue;
          }
          if ((damagedQty > 0 || missingQty > 0) && !remarks.trim()) {
            errors.push(`Batch "${b.batchNumber}": remarks are required when reporting damaged/missing units`);
            continue;
          }

          const sourceBatchStock = await BatchStock.findById(b.batchStockId).session(session);
          if (!sourceBatchStock) {
            errors.push(`Batch "${b.batchNumber}" record could not be found`);
            continue;
          }

          batchLog.push({ item, sourceBatch: b, sourceBatchStock, goodQty, damagedQty, missingQty, remarks });
        }
      }
    }

    if (errors.length > 0) {
      return rollback(errors.join("\n"), 400);
    }

    const now = new Date();

    // ============================================================
    // APPLY - serialized
    // ============================================================
    for (const { itemSerial, serialRecord, condition, remarks } of serialLog) {
      if (condition === "GOOD") {
        serialRecord.status = "AVAILABLE";
        serialRecord.currentBranchId = transfer.destinationBranchId;
        serialRecord.assignedBranchId = null;
        serialRecord.receivedAt = now;
      } else {
        serialRecord.status = condition; // DAMAGED | MISSING
        serialRecord.currentBranchId = condition === "DAMAGED" ? transfer.destinationBranchId : null;
        serialRecord.assignedBranchId = null;
        serialRecord.remarks = remarks;
        serialRecord.conditionUpdatedBy = user._id;
        serialRecord.conditionUpdatedAt = now;
      }
      await serialRecord.save({ session });

      itemSerial.condition = condition;
      itemSerial.remarks = remarks;

      if (condition !== "MISSING") {
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
          notes: `Serial ${serialRecord.serialNumber} received at ${transfer.destinationBranchName} as ${condition} (transfer ${transfer.transferNumber})`,
          session,
        });
      }
    }

    // ============================================================
    // APPLY - non-serialized: find-or-create destination BatchStock,
    // seeded from the SOURCE batch's own recorded price/GST (the exact
    // batch this quantity actually came from), never a generic lookup.
    // ============================================================
    for (const { item, sourceBatch, sourceBatchStock, goodQty, damagedQty, missingQty, remarks } of batchLog) {
      sourceBatch.receivedGoodQuantity = goodQty;
      sourceBatch.receivedDamagedQuantity = damagedQty;
      sourceBatch.receivedMissingQuantity = missingQty;
      sourceBatch.remarks = remarks;

      if (goodQty + damagedQty > 0) {
        let destBatchStock = await BatchStock.findOne({
          batchId: sourceBatchStock.batchId,
          branchId: transfer.destinationBranchId,
        }).session(session);

        if (destBatchStock) {
          destBatchStock.quantity += goodQty + damagedQty;
          destBatchStock.availableQuantity += goodQty;
          destBatchStock.damagedQuantity += damagedQty;
          await destBatchStock.save({ session });
        } else {
          destBatchStock = new BatchStock({
            batchId: sourceBatchStock.batchId,
            productId: item.productId,
            branchId: transfer.destinationBranchId,
            batchNumber: sourceBatchStock.batchNumber,
            barcode: sourceBatchStock.barcode || sourceBatchStock.batchNumber,
            productCode: item.productCode || sourceBatchStock.productCode,
            purchaseId: sourceBatchStock.purchaseId,
            quantity: goodQty + damagedQty,
            availableQuantity: goodQty,
            damagedQuantity: damagedQty,
            soldQuantity: 0,
            purchasePrice: sourceBatchStock.purchasePrice,
            sellingPrice: sourceBatchStock.sellingPrice,
            gstApplicable: sourceBatchStock.gstApplicable,
            purchaseGstPercent: sourceBatchStock.purchaseGstPercent,
            status: "ACTIVE",
          });
          await destBatchStock.save({ session });
        }

        // Only the GOOD portion gets its own StockMovement row - the
        // dedupe index on (referenceType, referenceId, batchId, type)
        // allows only ONE TRANSFER_IN row per batch per transfer, so a
        // damaged portion can't get a second row of the same type under
        // the same reference. Damaged/missing quantities are still
        // fully recorded on the Transfer document itself
        // (sourceBatch.receivedDamagedQuantity/receivedMissingQuantity)
        // and on the destination BatchStock's own damagedQuantity field -
        // nothing is lost, it just isn't duplicated into the ledger.
        if (goodQty > 0) {
          await recordStockMovement({
            type: "TRANSFER_IN",
            productId: item.productId,
            branchId: transfer.destinationBranchId,
            batchId: sourceBatchStock.batchId,
            quantityDelta: goodQty,
            resultingAvailableQuantity: destBatchStock.availableQuantity,
            unitCost: sourceBatchStock.purchasePrice,
            gstApplicable: sourceBatchStock.gstApplicable,
            gstPercent: sourceBatchStock.purchaseGstPercent,
            branchFrom: transfer.sourceBranchId,
            branchTo: transfer.destinationBranchId,
            referenceType: "Transfer",
            referenceId: transfer._id,
            performedBy: user._id,
            performedByName: user.name || "",
            notes: damagedQty > 0
              ? `${goodQty} unit(s) of batch ${sourceBatch.batchNumber} received GOOD (+${damagedQty} damaged) at ${transfer.destinationBranchName} (transfer ${transfer.transferNumber})`
              : `${goodQty} unit(s) of batch ${sourceBatch.batchNumber} received at ${transfer.destinationBranchName} (transfer ${transfer.transferNumber})`,
            session,
          });
        }
      }
      // missingQty: never arrived, no destination-side movement at all.
    }

    transfer.status = "RECEIVED";
    transfer.receivedBy = user._id;
    transfer.receivedByName = user.name;
    transfer.receivedAt = now;
    await transfer.save({ session });

    await TransferHistory.create(
      [
        {
          transferId: transfer._id,
          transferNumber: transfer.transferNumber,
          action: "RECEIVED",
          fromStatus: "DISPATCHED",
          toStatus: "RECEIVED",
          notes: notes || `Transfer received by ${user.name} at ${transfer.destinationBranchName}`,
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
      .populate("destinationBranchId", "name code");

    return successResponse(res, "Transfer received successfully", { transfer: populatedTransfer });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Receive Transfer Error:", error);
    if (error.code === 11000) {
      return errorResponse(res, "This transfer has already been received. Please refresh.", 409);
    }
    return errorResponse(res, error.message || "Failed to receive transfer", 500);
  }
};
