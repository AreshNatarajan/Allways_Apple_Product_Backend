// controllers/transfer/getProductAvailability.controller.js
import mongoose from "mongoose";
import Product from "../../models/Product.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Inventory from "../../models/Inventory.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// ============================================================
// Phase 1 - SOURCE BRANCH STOCK VISIBILITY
// Serialized: Product Name / Code / Available Quantity / Available
// Serial Count only - individual serial numbers are never shown here
// (they're only ever selected later, at Phase 2 packing, via a real
// scan/manual entry against ProductSerial).
// Non-serialized: Product Name / Code / Available Quantity only - no
// batch numbers here either, same reasoning.
//
// A serial that's mid-transfer (packed for a DIFFERENT pending
// request) is already excluded automatically: packing flips its
// status away from AVAILABLE to RESERVED, so this simple
// status:"AVAILABLE" match is always accurate without needing to
// separately cross-reference other Transfer documents (the previous
// version did, before RESERVED existed as a real status).
// ============================================================
export const getProductAvailabilityController = async (req, res) => {
  try {
    const { search = "", sourceBranchId } = req.query;

    if (!sourceBranchId) {
      return errorResponse(res, "Source branch ID is required", 400);
    }

    const { branch: sourceBranch, error: branchError } = await resolveActiveBranch(sourceBranchId);
    if (branchError) {
      return errorResponse(res, `Source branch: ${branchError}`, 400);
    }

    const searchFilter = { isDeleted: false, isActive: true };
    if (search && search.trim() !== "") {
      const searchRegex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      searchFilter.$or = [
        { name: searchRegex },
        { productCode: searchRegex },
        { category: searchRegex },
      ];
    }

    const products = await Product.find(searchFilter).lean();
    if (products.length === 0) {
      return successResponse(res, "No products found", {
        items: [],
        summary: { totalProducts: 0, availableProducts: 0, sourceBranchId, searchTerm: search || "all" },
      });
    }

    const productIds = products.map((p) => p._id);
    const serializedIds = products.filter((p) => p.isSerialized).map((p) => p._id);
    const nonSerializedIds = products.filter((p) => !p.isSerialized).map((p) => p._id);

    // ---- Serialized: count of AVAILABLE serials per product ----
    const serialCounts = serializedIds.length
      ? await ProductSerial.aggregate([
          {
            $match: {
              productId: { $in: serializedIds },
              currentBranchId: new mongoose.Types.ObjectId(sourceBranchId),
              status: "AVAILABLE",
              isDeleted: false,
            },
          },
          { $group: { _id: "$productId", count: { $sum: 1 } } },
        ])
      : [];
    const serialCountMap = new Map(serialCounts.map((s) => [s._id.toString(), s.count]));

    // ---- Non-serialized: BatchStock is the real ledger, Inventory is a
    // fallback for stock that predates batch tracking ----
    const batchTotals = nonSerializedIds.length
      ? await BatchStock.aggregate([
          {
            $match: {
              productId: { $in: nonSerializedIds },
              branchId: new mongoose.Types.ObjectId(sourceBranchId),
              status: "ACTIVE",
            },
          },
          { $group: { _id: "$productId", total: { $sum: "$availableQuantity" } } },
        ])
      : [];
    const batchTotalMap = new Map(batchTotals.map((b) => [b._id.toString(), b.total]));

    const productsWithoutBatchStock = nonSerializedIds.filter((id) => !batchTotalMap.has(id.toString()));
    const inventoryFallback = productsWithoutBatchStock.length
      ? await Inventory.aggregate([
          {
            $match: {
              productId: { $in: productsWithoutBatchStock },
              branchId: new mongoose.Types.ObjectId(sourceBranchId),
              quantity: { $gt: 0 },
            },
          },
        ])
      : [];
    const inventoryMap = new Map(inventoryFallback.map((i) => [i.productId.toString(), i.quantity]));

    // ---- Build response ----
    const items = products
      .map((product) => {
        const pid = product._id.toString();
        if (product.isSerialized) {
          const availableSerialCount = serialCountMap.get(pid) || 0;
          return {
            productId: product._id,
            productName: product.name,
            productCode: product.productCode || "",
            category: product.category,
            isSerialized: true,
            availableQuantity: availableSerialCount,
            availableSerialCount,
            isAvailable: availableSerialCount > 0,
          };
        }
        const availableQuantity = batchTotalMap.get(pid) ?? inventoryMap.get(pid) ?? 0;
        return {
          productId: product._id,
          productName: product.name,
          productCode: product.productCode || "",
          category: product.category,
          isSerialized: false,
          availableQuantity,
          isAvailable: availableQuantity > 0,
        };
      })
      .filter((item) => item.isAvailable)
      .sort((a, b) => a.productName.localeCompare(b.productName));

    return successResponse(res, "Products retrieved successfully", {
      items,
      summary: {
        totalProducts: products.length,
        availableProducts: items.length,
        sourceBranchId,
        sourceBranchName: sourceBranch.name,
        searchTerm: search || "all",
      },
    });
  } catch (error) {
    console.error("Get Product Availability Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve products", 500);
  }
};
