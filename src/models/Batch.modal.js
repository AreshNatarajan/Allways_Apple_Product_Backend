// models/Batch.modal.js
import mongoose from "mongoose";

const batchSchema = new mongoose.Schema(
  {
    // ============================================================
    // BATCH IDENTITY
    // ============================================================

    batchNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    // ============================================================
    // ORIGINAL PURCHASE DETAILS
    // ============================================================

    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      required: true,
    },

    // Copied from Purchase.source at creation - lets this batch's own
    // record (not just its Purchase ancestor) identify whether it came
    // from a real vendor or a Type 2 Exchange customer trade-in. See
    // Purchase.modal.js's own comment for the full rationale.
    source: {
      type: String,
      enum: ["VENDOR_PURCHASE", "CUSTOMER_EXCHANGE"],
      default: "VENDOR_PURCHASE",
    },

    purchasePrice: {
      type: Number,
      required: true,
      min: 0,
    },

    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
    },

    // Original quantity created for this batch.
    // Current branch-wise quantity is handled by BatchStock.
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    // ============================================================
    // GST (purchase-time decision, persisted so Sale never has to
    // trust a client-supplied value). Non-serialized products use
    // normal (not margin-based) GST.
    // ============================================================

    gstApplicable: {
      type: Boolean,
      default: true,
    },

    // Input GST paid at purchase time.
    purchaseGstPercent: {
      type: Number,
      default: 0,
    },

    // Output GST rate to apply at sale time. Deliberately NOT defaulted
    // from purchaseGstPercent at creation - output GST is a function of
    // the rate in effect on the SALE date, not the purchase date (input
    // tax and output tax are legitimately different numbers if the
    // government changes the rate while this batch sits in stock).
    // Stays at its schema default until the Sale-phase implementation
    // populates it from GstConfig at the actual moment of sale.
    saleGstPercent: {
      type: Number,
      default: 0,
    },

    // ============================================================
    // BATCH STATUS
    // ============================================================

    status: {
      type: String,
      enum: ["ACTIVE", "EXHAUSTED", "CANCELLED"],
      default: "ACTIVE",
    },

    // ============================================================
    // NOTES
    // ============================================================

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

// Find batches for a product
batchSchema.index({
  productId: 1,
  status: 1,
});

// Find batches created from a purchase
batchSchema.index({
  purchaseId: 1,
});

// batchNumber already has a unique index because of:
// unique: true

const Batch = mongoose.model("Batch", batchSchema);

export default Batch;


