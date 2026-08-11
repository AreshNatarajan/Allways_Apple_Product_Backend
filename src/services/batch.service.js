// services/batch.service.js
import Batch from "../models/Batch.modal.js";
import Inventory from "../models/Inventory.modal.js";
import mongoose from "mongoose";

class BatchService {
  /**
   * Generate simple batch number
   */
  static generateBatchNumber(productCode) {
    const date = new Date();
    const timestamp = Date.now().toString().slice(-6);
    return `${productCode}-${timestamp}`;
  }

  /**
   * Create batches from purchase
   */
  static async createBatchesFromPurchase(purchase, session) {
    const createdBatches = [];

    for (const [itemIndex, item] of purchase.items.entries()) {
      // Skip if no batches
      if (!item.batches || item.batches.length === 0) continue;

      const product = await Product.findById(item.productId).session(session);
      const productCode = product.productCode || product._id.toString().slice(-6);

      for (const batchData of item.batches) {
        // Generate batch number if not provided
        if (!batchData.batchNumber) {
          batchData.batchNumber = this.generateBatchNumber(productCode);
        }

        // Create batch
        const batch = new Batch({
          batchNumber: batchData.batchNumber,
          branchId: purchase.branchId,
          productId: item.productId,
          purchasePrice: batchData.purchasePrice || item.purchasePrice,
          sellingPrice: batchData.sellingPrice || item.sellingPrice,
          quantity: batchData.quantity,
          availableQuantity: batchData.quantity,
          purchaseId: purchase._id,
          status: "ACTIVE",
          notes: batchData.notes || "",
        });

        await batch.save({ session });
        
        // Store reference
        batchData.batchId = batch._id;
        createdBatches.push(batch);
      }

      // Update inventory
      let inventory = await Inventory.findOne({
        branchId: purchase.branchId,
        productId: item.productId,
      }).session(session);

      if (!inventory) {
        inventory = new Inventory({
          branchId: purchase.branchId,
          productId: item.productId,
          quantity: 0,
        });
      }

      const totalQty = item.batches.reduce((sum, b) => sum + b.quantity, 0);
      inventory.quantity += totalQty;
      await inventory.save({ session });
    }

    return createdBatches;
  }

  /**
   * Get available batches (FIFO)
   */
  static async getAvailableBatches(branchId, productId) {
    return await Batch.find({
      branchId,
      productId,
      availableQuantity: { $gt: 0 },
      status: "ACTIVE",
    }).sort({ createdAt: 1 }); // FIFO - oldest first
  }

  /**
   * Select batches for sale (FIFO)
   */
  static async selectBatchesForSale(branchId, productId, quantity, sellingPrice) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const batches = await this.getAvailableBatches(branchId, productId);
      
      if (batches.length === 0) {
        throw new Error("No stock available for this product");
      }

      let remainingQty = quantity;
      const selectedBatches = [];

      for (const batch of batches) {
        if (remainingQty <= 0) break;

        const takeQty = Math.min(batch.availableQuantity, remainingQty);
        const profit = (sellingPrice - batch.purchasePrice) * takeQty;

        selectedBatches.push({
          batchId: batch._id,
          batchNumber: batch.batchNumber,
          quantity: takeQty,
          purchasePrice: batch.purchasePrice,
          sellingPrice: sellingPrice,
          profit: profit,
        });

        // Update batch
        batch.availableQuantity -= takeQty;
        if (batch.availableQuantity === 0) {
          batch.status = "EXHAUSTED";
        }
        await batch.save({ session });

        remainingQty -= takeQty;
      }

      if (remainingQty > 0) {
        throw new Error(`Only ${quantity - remainingQty} units available`);
      }

      // Update inventory
      const inventory = await Inventory.findOne({
        branchId,
        productId,
      }).session(session);

      if (inventory) {
        inventory.quantity -= quantity;
        await inventory.save({ session });
      }

      await session.commitTransaction();
      return selectedBatches;

    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Update batch with sale info
   */
  static async updateBatchWithSale(sale, session) {
    for (const item of sale.items) {
      if (!item.batches || item.batches.length === 0) continue;

      for (const batchData of item.batches) {
        const batch = await Batch.findById(batchData.batchId).session(session);
        if (batch) {
          batch.sales.push({
            saleId: sale._id,
            quantity: batchData.quantity,
            sellingPrice: batchData.sellingPrice,
            profit: batchData.profit,
          });
          await batch.save({ session });
        }
      }
    }
  }

  /**
   * Get simple batch report
   */
  static async getBatchReport(branchId, productId) {
    const batches = await Batch.find({
      branchId,
      productId,
    }).sort({ createdAt: -1 });

    return {
      totalBatches: batches.length,
      totalQuantity: batches.reduce((sum, b) => sum + b.quantity, 0),
      totalAvailable: batches.reduce((sum, b) => sum + b.availableQuantity, 0),
      totalProfit: batches.reduce((sum, b) => sum + b.totalProfit, 0),
      batches: batches.map(b => ({
        batchNumber: b.batchNumber,
        purchasePrice: b.purchasePrice,
        sellingPrice: b.sellingPrice,
        quantity: b.quantity,
        available: b.availableQuantity,
        sold: b.totalSold,
        profit: b.totalProfit,
        status: b.status,
        createdAt: b.createdAt,
      })),
    };
  }
}

export default BatchService;