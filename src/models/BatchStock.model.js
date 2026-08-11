// models/BatchStock.model.js
import mongoose from "mongoose";

const batchStockSchema = new mongoose.Schema(
  {
    // ============================================================
    // BATCH REFERENCE
    // ============================================================
    // Parent Batch document.
    // Same batch can have BatchStock records in multiple branches.
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      required: true,
    },

    // ============================================================
    // PRODUCT
    // ============================================================
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    // ============================================================
    // BRANCH
    // ============================================================
    // Branch where this particular batch stock physically exists.
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    // ============================================================
    // BATCH IDENTIFICATION
    // ============================================================
    // Example:
    // AAP30WCH-MRI-B001
    // AAP30WCH-SLM-B001
    // AAP30WCH-MDU-B001
    batchNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },

    // Barcode printed on the physical product/package.
    // In our current design this is the batch barcode.
    barcode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },

    // Product code for easy searching/reporting.
    productCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },

    // ============================================================
    // PURCHASE REFERENCE
    // ============================================================
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      required: true,
    },

    // ============================================================
    // QUANTITY
    // ============================================================
    // Original quantity added to this branch's batch stock.
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },

    // Current quantity available for sale.
    availableQuantity: {
      type: Number,
      required: true,
      min: 0,
    },

    // Total quantity sold from this branch's batch stock.
    soldQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Total quantity damaged from this branch's batch stock.
    damagedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ============================================================
    // PRICE
    // ============================================================
    // Price at the time this batch was purchased.
    purchasePrice: {
      type: Number,
      required: true,
      min: 0,
    },

    // Selling price for this batch.
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
    },

    // ============================================================
    // GST
    // ============================================================
    // Denormalized copy of Batch.gstApplicable/purchaseGstPercent, set
    // once at creation from the same helper that creates the Batch -
    // same pattern already used above for purchasePrice/sellingPrice.
    // Source of truth is still Batch; this copy exists purely so Sale
    // doesn't need an extra populate() on every scan.
    gstApplicable: {
      type: Boolean,
      default: true,
    },

    purchaseGstPercent: {
      type: Number,
      default: 0,
    },

    // Deliberately NOT copied from purchaseGstPercent at creation - see
    // the matching comment on Batch.saleGstPercent. The Sale-phase
    // implementation must look this rate up fresh from GstConfig at the
    // moment of sale, never trust a value stamped here at purchase time.
    saleGstPercent: {
      type: Number,
      default: 0,
    },

    // ============================================================
    // STATUS
    // ============================================================
    status: {
      type: String,
      enum: ["ACTIVE", "EXHAUSTED", "CANCELLED"],
      default: "ACTIVE",
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// ============================================================
// INDEXES
// ============================================================

// One BatchStock record per Batch per Branch.
//
// Same Batch:
// B001 + Chennai
// B001 + Salem
// B001 + Madurai
//
// Each combination is unique.
batchStockSchema.index(
  {
    batchId: 1,
    branchId: 1,
  },
  {
    unique: true,
  }
);

// Product stock lookup inside a branch.
batchStockSchema.index({
  branchId: 1,
  productId: 1,
  status: 1,
});

// Purchase → BatchStock lookup.
batchStockSchema.index({
  purchaseId: 1,
});

// Product-code based branch lookup.
batchStockSchema.index({
  productCode: 1,
  branchId: 1,
});

// Barcode must identify exactly one batch stock WITHIN a branch - not
// globally. A CENTRAL (SUPER_ADMIN) purchase can legitimately split one
// batch's already-printed barcode across several destination branches
// (same physical label, shipped to more than one place), so the same
// barcode now correctly appears on more than one BatchStock row as long
// as each row is a different branch. {batchId, branchId} above already
// guards the true duplicate case (same batch received twice at the same
// branch); this pairs the same scoping for barcode specifically, since
// barcode is what an in-branch sale/scan flow actually looks up by.
batchStockSchema.index(
  {
    barcode: 1,
    branchId: 1,
  },
  {
    unique: true,
  }
);

const BatchStock = mongoose.model("BatchStock", batchStockSchema);

export default BatchStock;

