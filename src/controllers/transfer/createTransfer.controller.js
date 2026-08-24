// controllers/transfer/createTransfer.controller.js
import mongoose from "mongoose";
import Transfer from "../../models/Transfer.modal.js";
import TransferHistory from "../../models/TransferHistory.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Product from "../../models/Product.modal.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";
import { generateDocumentNumber } from "../../services/documentNumber.service.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// ============================================================
// CREATE TRANSFER - direct selection, no request/approval step.
// Every item is fully decided right here (exact serial numbers for a
// serialized product, exact source batch(es)+quantity for a
// non-serialized one - never auto-consumed oldest-first, this app has
// no FIFO anywhere) - there is no later "packing" scan that fills in
// the real units, unlike the old request-based flow.
//
// Stock is RESERVED immediately, right here at creation - a serialized
// unit flips AVAILABLE->RESERVED and a non-serialized batch's
// availableQuantity is decremented the moment it's picked, so the same
// unit/quantity can never be picked into a second transfer (or sold)
// while this one is still in progress. This is also why CANCEL (only
// ever allowed from PROCESSING/PACKED, before DISPATCH) has to reverse
// it - see updateTransferStatus.controller.js. DISPATCH itself moves no
// further quantity - it only flips the already-reserved serial from
// RESERVED to IN_TRANSIT (a ProductSerial-level physical marker, not a
// Transfer-level stage - the Transfer's own status goes straight
// PACKED -> DISPATCHED -> RECEIVED, no separate "in transit" stage).
// ============================================================
export const createTransferController = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  const rollback = async (message, statusCode = 400) => {
    await session.abortTransaction();
    session.endSession();
    return errorResponse(res, message, statusCode);
  };

  try {
    const user = req.user;
    const isSuperAdmin = user.role === "SUPER_ADMIN";
    let { sourceBranchId, destinationBranchId, items, notes } = req.body;

    // ============================================================
    // ROLE RULES - SUPER_ADMIN has no branch of their own, so they pick
    // both sides. Every other role's source branch is always their own
    // branch - never trusted from the request body.
    // ============================================================
    if (!isSuperAdmin) {
      if (!user.branchId) return rollback("Branch not assigned to user", 400);
      sourceBranchId = user.branchId.toString();
    }

    if (!sourceBranchId) return rollback("Source branch is required", 400);
    if (!destinationBranchId) return rollback("Destination branch is required", 400);
    if (sourceBranchId.toString() === destinationBranchId.toString()) {
      return rollback("Source and destination branches cannot be the same", 400);
    }
    if (!items || items.length === 0) return rollback("At least one item is required", 400);

    const [sourceResolved, destinationResolved] = await Promise.all([
      resolveActiveBranch(sourceBranchId),
      resolveActiveBranch(destinationBranchId),
    ]);
    if (sourceResolved.error) return rollback(`Source branch: ${sourceResolved.error}`, 400);
    if (destinationResolved.error) return rollback(`Destination branch: ${destinationResolved.error}`, 400);
    const sourceBranch = sourceResolved.branch;
    const destinationBranch = destinationResolved.branch;

    // ============================================================
    // VALIDATE ITEMS - real serial/batch selection, checked against the
    // actual current ProductSerial/BatchStock records. No mutation.
    // ============================================================
    const processedItems = [];
    const errors = [];
    const serialsToReserve = [];
    const batchesToReserve = [];

    for (const item of items) {
      const { productId } = item;

      if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
        errors.push("A valid Product ID is required for every item");
        continue;
      }

      const product = await Product.findOne({ _id: productId, isDeleted: false }).session(session).lean();
      if (!product) {
        errors.push(`Invalid product: ${item.productName || productId} not found`);
        continue;
      }

      if (product.isSerialized) {
        const serialIds = Array.isArray(item.serialIds) ? item.serialIds.filter(Boolean) : [];
        if (serialIds.length === 0) {
          errors.push(`${product.name}: select at least one serial number`);
          continue;
        }

        const serialRecords = await ProductSerial.find({
          _id: { $in: serialIds },
          isDeleted: false,
        }).session(session);

        if (serialRecords.length !== serialIds.length) {
          errors.push(`${product.name}: one or more selected serials could not be found`);
          continue;
        }

        const badSerial = serialRecords.find(
          (s) =>
            s.productId.toString() !== productId.toString() ||
            s.status !== "AVAILABLE" ||
            !s.currentBranchId ||
            s.currentBranchId.toString() !== sourceBranchId.toString()
        );
        if (badSerial) {
          errors.push(`${product.name}: serial "${badSerial.serialNumber}" is not available at ${sourceBranch.name}`);
          continue;
        }

        processedItems.push({
          productId,
          productName: product.name,
          productCode: product.productCode || "",
          isSerialized: true,
          quantity: serialRecords.length,
          serials: serialRecords.map((s) => ({ serialNumber: s.serialNumber, productSerialId: s._id })),
        });
        serialsToReserve.push(...serialRecords);
      } else {
        const sourceBatches = Array.isArray(item.sourceBatches) ? item.sourceBatches : [];
        if (sourceBatches.length === 0) {
          errors.push(`${product.name}: select at least one source batch and quantity`);
          continue;
        }

        const batchStockIds = sourceBatches.map((b) => b.batchStockId).filter(Boolean);
        const batchStocks = await BatchStock.find({
          _id: { $in: batchStockIds },
          branchId: sourceBranchId,
          productId,
          status: "ACTIVE",
        }).session(session);
        const batchStockById = new Map(batchStocks.map((b) => [b._id.toString(), b]));

        let totalQty = 0;
        const resolvedBatches = [];
        let batchError = null;

        for (const b of sourceBatches) {
          const qty = Number(b.quantity) || 0;
          const batchStock = batchStockById.get(String(b.batchStockId));
          if (!batchStock) {
            batchError = `${product.name}: selected batch could not be found at ${sourceBranch.name}`;
            break;
          }
          if (qty <= 0) {
            batchError = `${product.name}: quantity must be greater than 0 for batch ${batchStock.batchNumber}`;
            break;
          }
          if (qty > batchStock.availableQuantity) {
            batchError = `${product.name}: batch ${batchStock.batchNumber} only has ${batchStock.availableQuantity} available, requested ${qty}`;
            break;
          }
          totalQty += qty;
          resolvedBatches.push({
            batchStockId: batchStock._id,
            batchId: batchStock.batchId,
            batchNumber: batchStock.batchNumber,
            quantity: qty,
          });
          batchesToReserve.push({ batchStock, quantity: qty, productId, productCode: product.productCode || "" });
        }

        if (batchError) {
          errors.push(batchError);
          continue;
        }

        processedItems.push({
          productId,
          productName: product.name,
          productCode: product.productCode || "",
          isSerialized: false,
          quantity: totalQty,
          sourceBatches: resolvedBatches,
        });
      }
    }

    if (errors.length > 0) {
      return rollback(errors.join("\n"), 400);
    }

    // ============================================================
    // CREATE TRANSFER - status PROCESSING. Prefix read fresh from
    // Global Settings on every create.
    // ============================================================
    const gstConfigForNumber = await getOrCreateGstConfig({ session });
    const transferNumber = await generateDocumentNumber("transfer", gstConfigForNumber.documentPrefixes.transfer, { session });

    const [transfer] = await Transfer.create(
      [
        {
          transferNumber,
          sourceBranchId,
          sourceBranchName: sourceBranch.name,
          destinationBranchId,
          destinationBranchName: destinationBranch.name,
          items: processedItems,
          notes: notes || "",
          status: "PROCESSING",
          createdBy: user._id,
          createdByName: user.name,
        },
      ],
      { session }
    );

    // ============================================================
    // RESERVE - flips every picked serial to RESERVED and decrements
    // every picked batch's availableQuantity, right now, so nothing
    // picked here can be picked into a second transfer (or sold) while
    // this one is in progress. This is the actual "stock leaves the
    // source branch's available pool" moment, so it's also where
    // TRANSFER_OUT gets recorded - DISPATCH/PACKED afterward are pure
    // status flags with no further mutation.
    // ============================================================
    for (const serialRecord of serialsToReserve) {
      serialRecord.status = "RESERVED";
      await serialRecord.save({ session });

      await recordStockMovement({
        type: "TRANSFER_OUT",
        productId: serialRecord.productId,
        branchId: sourceBranchId,
        serialId: serialRecord._id,
        quantityDelta: -1,
        unitCost: serialRecord.purchasePrice,
        gstApplicable: serialRecord.gstApplicable,
        gstPercent: serialRecord.purchaseGstPercent,
        branchFrom: sourceBranchId,
        branchTo: destinationBranchId,
        referenceType: "Transfer",
        referenceId: transfer._id,
        performedBy: user._id,
        performedByName: user.name || "",
        notes: `Serial ${serialRecord.serialNumber} reserved for transfer ${transfer.transferNumber} to ${destinationBranch.name}`,
        session,
      });
    }

    for (const { batchStock, quantity, productId: batchProductId } of batchesToReserve) {
      batchStock.availableQuantity -= quantity;
      await batchStock.save({ session });

      await recordStockMovement({
        type: "TRANSFER_OUT",
        productId: batchProductId,
        branchId: sourceBranchId,
        batchId: batchStock.batchId,
        quantityDelta: -quantity,
        resultingAvailableQuantity: batchStock.availableQuantity,
        unitCost: batchStock.purchasePrice,
        gstApplicable: batchStock.gstApplicable,
        gstPercent: batchStock.purchaseGstPercent,
        branchFrom: sourceBranchId,
        branchTo: destinationBranchId,
        referenceType: "Transfer",
        referenceId: transfer._id,
        performedBy: user._id,
        performedByName: user.name || "",
        notes: `${quantity} unit(s) of batch ${batchStock.batchNumber} reserved for transfer ${transfer.transferNumber} to ${destinationBranch.name}`,
        session,
      });
    }

    await TransferHistory.create(
      [
        {
          transferId: transfer._id,
          transferNumber: transfer.transferNumber,
          action: "CREATED",
          fromStatus: null,
          toStatus: "PROCESSING",
          notes: `Transfer created by ${user.name} for ${destinationBranch.name}`,
          performedBy: user._id,
          performedByName: user.name,
          affectedItems: processedItems.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            serials: item.isSerialized ? item.serials.map((s) => s.serialNumber) : [],
          })),
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    const populatedTransfer = await Transfer.findById(transfer._id)
      .populate("sourceBranchId", "name code")
      .populate("destinationBranchId", "name code")
      .populate("createdBy", "name email");

    return successResponse(res, "Transfer created successfully", {
      transfer: populatedTransfer,
      summary: {
        totalItems: processedItems.length,
        totalQuantity: processedItems.reduce((sum, item) => sum + item.quantity, 0),
        serializedItems: processedItems.filter((item) => item.isSerialized).length,
        nonSerializedItems: processedItems.filter((item) => !item.isSerialized).length,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Create Transfer Error:", error);
    return errorResponse(res, error.message || "Failed to create transfer", 500);
  }
};
