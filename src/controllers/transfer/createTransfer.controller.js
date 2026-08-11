// controllers/transfer/createTransfer.controller.js
import mongoose from "mongoose";
import Transfer from "../../models/Transfer.modal.js";
import TransferHistory from "../../models/TransferHistory.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Inventory from "../../models/Inventory.modal.js";
import Product from "../../models/Product.modal.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";
import { generateDocumentNumber } from "../../services/documentNumber.service.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Total sellable quantity for a non-serialized product at a branch -
// BatchStock is the real per-batch ledger; the flat Inventory
// collection is only consulted as a fallback for stock that predates
// batch tracking (never double-counted).
const getNonSerializedAvailability = async (productId, branchId) => {
  const rows = await BatchStock.aggregate([
    { $match: { productId: new mongoose.Types.ObjectId(productId), branchId: new mongoose.Types.ObjectId(branchId), status: "ACTIVE" } },
    { $group: { _id: null, total: { $sum: "$availableQuantity" } } },
  ]);
  const batchTotal = rows[0]?.total || 0;
  if (batchTotal > 0) return batchTotal;

  const inventory = await Inventory.findOne({ productId, branchId }).lean();
  return inventory?.quantity || 0;
};

// ============================================================
// Phase 1 - CREATE TRANSFER REQUEST
// Quantity-only: no serial numbers, no batch numbers, no scanning, no
// inventory change of any kind. Real serial/batch selection happens
// during Phase 2 packing at the source branch.
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
    let { sourceBranchId, destinationBranchId, items, reason, reasonText, notes } = req.body;

    // ============================================================
    // ROLE RULES
    // SUPER_ADMIN: chooses both source and destination.
    // BRANCH_ADMIN: destination is always their own branch - never
    // trusted from the request body, matching the project-wide rule of
    // never trusting role/branchId claims from the client.
    // ============================================================
    if (!isSuperAdmin) {
      if (!user.branchId) return rollback("Branch not assigned to user", 400);
      destinationBranchId = user.branchId.toString();
    }

    if (!sourceBranchId) return rollback("Source branch is required", 400);
    if (!destinationBranchId) return rollback("Destination branch is required", 400);
    if (sourceBranchId.toString() === destinationBranchId.toString()) {
      return rollback("Source and destination branches cannot be the same", 400);
    }
    if (!items || items.length === 0) return rollback("At least one item is required", 400);
    if (!reason) return rollback("Transfer reason is required", 400);

    const [sourceResolved, destinationResolved] = await Promise.all([
      resolveActiveBranch(sourceBranchId),
      resolveActiveBranch(destinationBranchId),
    ]);
    if (sourceResolved.error) return rollback(`Source branch: ${sourceResolved.error}`, 400);
    if (destinationResolved.error) return rollback(`Destination branch: ${destinationResolved.error}`, 400);
    const sourceBranch = sourceResolved.branch;
    const destinationBranch = destinationResolved.branch;

    // ============================================================
    // VALIDATE ITEMS - count/quantity availability only
    // ============================================================
    const processedItems = [];
    const errors = [];

    for (const item of items) {
      const { productId, quantity } = item;

      if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
        errors.push("A valid Product ID is required for every item");
        continue;
      }

      const qty = Number(quantity);
      if (!qty || qty < 1) {
        errors.push(`Quantity must be at least 1 for ${item.productName || "product"}`);
        continue;
      }

      const product = await Product.findOne({ _id: productId, isDeleted: false }).session(session).lean();
      if (!product) {
        errors.push(`Invalid product: ${item.productName || productId} not found`);
        continue;
      }

      if (product.isSerialized) {
        const availableCount = await ProductSerial.countDocuments({
          productId,
          currentBranchId: sourceBranchId,
          status: "AVAILABLE",
          isDeleted: false,
        }).session(session);

        if (availableCount < qty) {
          errors.push(`Insufficient serialized stock for ${product.name} at ${sourceBranch.name}. Available: ${availableCount}, Requested: ${qty}`);
          continue;
        }

        processedItems.push({
          productId,
          productName: product.name,
          productCode: product.productCode || "",
          isSerialized: true,
          quantity: qty,
          availableSerialCount: availableCount,
        });
      } else {
        const available = await getNonSerializedAvailability(productId, sourceBranchId);

        if (available < qty) {
          errors.push(`Insufficient stock for ${product.name} at ${sourceBranch.name}. Available: ${available}, Requested: ${qty}`);
          continue;
        }

        processedItems.push({
          productId,
          productName: product.name,
          productCode: product.productCode || "",
          isSerialized: false,
          quantity: qty,
        });
      }
    }

    if (errors.length > 0) {
      return rollback(errors.join("\n"), 400);
    }

    // ============================================================
    // CREATE TRANSFER - status REQUESTED, no inventory/serial mutation.
    // Prefix read fresh from Global Settings on every create.
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
          items: processedItems.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            productCode: item.productCode,
            isSerialized: item.isSerialized,
            quantity: item.quantity,
            serials: [],
            packedQuantity: 0,
            packedBatches: [],
            receivedQuantity: 0,
            damagedQuantity: 0,
            missingQuantity: 0,
            rejectedQuantity: 0,
          })),
          reason,
          reasonText: reasonText || "",
          notes: notes || "",
          status: "REQUESTED",
          createdBy: user._id,
          createdByName: user.name,
          // Non-SUPER_ADMIN: always their own branch (== destinationBranchId,
          // per the role rule above). SUPER_ADMIN has no branch of their
          // own, so the request is attributed to whichever branch it's
          // actually for - the destination.
          createdByBranchId: isSuperAdmin ? destinationBranchId : user.branchId,
          createdByBranchName: destinationBranch.name,
        },
      ],
      { session }
    );

    await TransferHistory.create(
      [
        {
          transferId: transfer._id,
          transferNumber: transfer.transferNumber,
          action: "CREATED",
          fromStatus: null,
          toStatus: "REQUESTED",
          notes: `Transfer requested by ${user.name} for ${destinationBranch.name}`,
          performedBy: user._id,
          performedByName: user.name,
          affectedItems: processedItems.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            serials: [],
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

    return successResponse(res, "Transfer requested successfully", {
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
