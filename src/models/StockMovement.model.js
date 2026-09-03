// models/StockMovement.model.js
import mongoose from "mongoose";

// Immutable, append-only ledger of every atomic quantity change to a
// Batch/BatchStock or ProductSerial, regardless of cause. This is the
// "historical record" half of the current-state/historical-state split -
// BatchStock.availableQuantity and ProductSerial.status answer "what do
// I have right now"; StockMovement answers "how did it get to that
// number, and when." Never updated or deleted once created - a
// correction is made by writing a new offsetting ADJUSTMENT row, never
// by editing a past one.
//
// Unified for both serialized and non-serialized events (mirrors the
// existing ProductSerial/BatchStock split - discriminated here by which
// of batchId/serialId is populated) rather than two separate
// collections, so "show every movement for this branch" is one query
// instead of a union of two differently-shaped ones.
const stockMovementSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "PURCHASE_RECEIVE_DIRECT",   // BRANCH_ADMIN direct purchase
        "PURCHASE_RECEIVE_CENTRAL",  // SUPER_ADMIN purchase, received at branch
        "CUSTOMER_EXCHANGE_RECEIVE", // Type 2 Exchange - customer trade-in received into stock
        "TRANSFER_OUT",
        "TRANSFER_IN",
        "SALE",
        "RETURN",                    // Sale Return - unit/quantity restored to branch stock
        "DAMAGE",
        "REJECT",
        "ADJUSTMENT",
      ],
      required: true,
    },

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    // Exactly one of these two is set, matching the product's
    // isSerialized flag. Enforced below via a pre('validate') hook -
    // Mongoose field-level validators can't see sibling fields
    // reliably, so this cross-field rule lives at the schema level.
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
      immutable: true,
    },

    serialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductSerial",
      default: null,
      immutable: true,
    },

    // +N for stock coming in, -N for stock going out. Always ±1 for
    // serialized movements (enforced below via pre('validate')).
    quantityDelta: {
      type: Number,
      required: true,
      immutable: true,
      validate: {
        validator: function (v) {
          return v !== 0;
        },
        message: "quantityDelta cannot be 0 - a zero-quantity movement is never a legitimate event.",
      },
    },

    // Snapshot of the balance immediately after this movement, for
    // point-in-time reconstruction without replaying the whole ledger.
    resultingAvailableQuantity: {
      type: Number,
      default: null,
    },

    // Cost basis at the moment of this movement - frozen, not a live
    // lookup, so historical cost reporting survives later batch edits.
    unitCost: {
      type: Number,
      default: 0,
      immutable: true,
    },

    // GST snapshot at the moment of this movement - same reasoning as
    // unitCost above.
    gstApplicable: {
      type: Boolean,
      default: false,
      immutable: true,
    },

    gstPercent: {
      type: Number,
      default: 0,
      immutable: true,
    },

    // Which branch stock left/arrived from, for TRANSFER_OUT/TRANSFER_IN.
    branchFrom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },

    branchTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },

    // Polymorphic pointer back to whichever higher-level event caused
    // this movement (Purchase, PendingReceive, ReceiveHistory,
    // Transfer, Sale) - lets a movement be traced back to its source
    // document without guessing which collection to look in.
    referenceType: {
      type: String,
      enum: ["Purchase", "PendingReceive", "ReceiveHistory", "Transfer", "Sale", "SaleReturn", "SaleExchange"],
      required: true,
      immutable: true,
    },

    referenceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      immutable: true,
    },

    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    performedByName: {
      type: String,
      default: "",
    },

    performedAt: {
      type: Date,
      default: Date.now,
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
// CROSS-FIELD VALIDATION
// ============================================================

// Promise-style middleware (no `next` parameter) - Mongoose 9 removed
// callback-style hooks entirely; a `next` argument is simply never
// passed, regardless of function signature. Throwing rejects.
stockMovementSchema.pre("validate", function () {
  const hasBatch = !!this.batchId;
  const hasSerial = !!this.serialId;

  if (hasBatch === hasSerial) {
    throw new Error(
      "Exactly one of batchId or serialId must be set on a StockMovement, never both or neither."
    );
  }

  if (hasSerial && Math.abs(this.quantityDelta) !== 1) {
    throw new Error("Serialized stock movements must have a quantityDelta of exactly +1 or -1.");
  }
});

// ============================================================
// APPEND-ONLY ENFORCEMENT
// ============================================================
// StockMovement is an immutable audit ledger - corrections are made by
// inserting a new offsetting ADJUSTMENT row, never by editing or
// deleting a past one. These hooks block every realistic Mongoose
// path to update or delete an existing document. They cannot stop a
// raw MongoDB driver / mongosh operation that bypasses Mongoose
// entirely - that boundary is infrastructure/ops scope, not schema
// scope.

const APPEND_ONLY_UPDATE_ERROR = new Error(
  "StockMovement records are append-only and cannot be updated. Write a new offsetting ADJUSTMENT record instead."
);
const APPEND_ONLY_DELETE_ERROR = new Error(
  "StockMovement records are append-only and cannot be deleted."
);

// Query-level updates: Model.updateOne(), Model.updateMany(),
// Model.findOneAndUpdate() / findByIdAndUpdate().
stockMovementSchema.pre("updateOne", { document: false, query: true }, function () {
  throw APPEND_ONLY_UPDATE_ERROR;
});
stockMovementSchema.pre("updateMany", function () {
  throw APPEND_ONLY_UPDATE_ERROR;
});
stockMovementSchema.pre("findOneAndUpdate", function () {
  throw APPEND_ONLY_UPDATE_ERROR;
});

// Query-level deletes: Model.deleteOne(), Model.deleteMany(),
// Model.findOneAndDelete() / findByIdAndDelete().
stockMovementSchema.pre("deleteOne", { document: false, query: true }, function () {
  throw APPEND_ONLY_DELETE_ERROR;
});
stockMovementSchema.pre("deleteMany", function () {
  throw APPEND_ONLY_DELETE_ERROR;
});
stockMovementSchema.pre("findOneAndDelete", function () {
  throw APPEND_ONLY_DELETE_ERROR;
});

// Document-level delete: doc.deleteOne() instance method.
stockMovementSchema.pre("deleteOne", { document: true, query: false }, function () {
  throw APPEND_ONLY_DELETE_ERROR;
});

// Document-level modification: doc.save() on an already-persisted
// document. isNew is true only for a genuinely new document, so
// creation via .create()/.save() is unaffected.
stockMovementSchema.pre("save", function () {
  if (!this.isNew) {
    throw APPEND_ONLY_UPDATE_ERROR;
  }
});

// ============================================================
// INDEXES
// ============================================================

stockMovementSchema.index({ batchId: 1, performedAt: -1 });
stockMovementSchema.index({ serialId: 1, performedAt: -1 });
stockMovementSchema.index({ branchId: 1, productId: 1, performedAt: -1 });
stockMovementSchema.index({ referenceType: 1, referenceId: 1 });

// Branch-wide chronological audit ("everything that happened at this
// branch") - the compound index above can't efficiently serve this on
// its own since productId sits between branchId and performedAt.
stockMovementSchema.index({ branchId: 1, performedAt: -1 });

// Who-did-what audit, matching the equivalent index already used on
// TransferHistory.
stockMovementSchema.index({ performedBy: 1, performedAt: -1 });

// Report-by-movement-type, matching the equivalent index already used
// on TransferHistory (action + performedAt).
stockMovementSchema.index({ type: 1, performedAt: -1 });

// Duplicate-movement protection: within a single referenced event
// (one specific Purchase/Sale/etc.), the same batch or serial can't
// have the same movement type recorded twice - guards against a
// double-submitted request creating two rows for one real event. Does
// NOT block the same batch/serial appearing in movements from
// DIFFERENT events (e.g. sold from repeatedly across separate sales),
// which is normal and expected.
//
// Transfer is now included too: the old request/scan-based Transfer
// flow allowed multiple partial scans of the same batch under one
// transfer (scan it once, add 2; scan it again later, add 3), which
// legitimately produced more than one movement row for the same
// transfer+batch+type. The current Transfer flow selects every item
// once, atomically, at creation - there is no longer a legitimate
// reason for the same batch/serial to get the same movement `type`
// twice under one Transfer, so the same duplicate-submission guard
// used everywhere else now applies here too.
//
// MongoDB partial index filters only support $eq/$exists/$gt/$gte/
// $lt/$lte/$type/$and - there is no $ne/$or, so "every referenceType"
// is expressed as one $eq-scoped index per type rather than a single
// negated one.
const DEDUPED_REFERENCE_TYPES = ["Purchase", "PendingReceive", "ReceiveHistory", "Sale", "Transfer", "SaleReturn", "SaleExchange"];
DEDUPED_REFERENCE_TYPES.forEach((referenceType) => {
  stockMovementSchema.index(
    { referenceType: 1, referenceId: 1, batchId: 1, serialId: 1, type: 1 },
    { unique: true, partialFilterExpression: { referenceType: { $eq: referenceType } }, name: `dedupe_movement_${referenceType}` }
  );
});

const StockMovement = mongoose.model("StockMovement", stockMovementSchema);

export default StockMovement;
