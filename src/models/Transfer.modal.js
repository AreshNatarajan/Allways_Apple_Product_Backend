// models/Transfer.model.js
import mongoose from "mongoose";

const transferItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productName: {
      type: String,
      required: true,
    },
    productCode: {
      type: String,
      default: "",
    },
    isSerialized: {
      type: Boolean,
      default: false,
    },
    // serials.length (serialized) or the sum of sourceBatches[].quantity
    // (non-serialized) - fixed at creation, never changed afterward.
    quantity: {
      type: Number,
      default: 1,
      min: 1,
    },
    // ============================================================
    // SERIALIZED - the exact physical units chosen at creation time
    // (direct selection from the source branch's available inventory,
    // never a later scan step). condition is set once, at RECEIVED.
    // ============================================================
    serials: [
      {
        serialNumber: {
          type: String,
          trim: true,
        },
        productSerialId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "ProductSerial",
        },
        condition: {
          type: String,
          enum: ["GOOD", "DAMAGED", "MISSING", null],
          default: null,
        },
        remarks: {
          type: String,
          default: "",
        },
      },
    ],
    // ============================================================
    // NON-SERIALIZED - the exact source batch(es) + quantity chosen at
    // creation time (this app has no FIFO auto-consumption anywhere -
    // the user always picks which batch(es) a transfer draws from,
    // same rule Sale already follows). receivedGood/Damaged/Missing are
    // set once, at RECEIVED, and must sum to at most `quantity`.
    // ============================================================
    sourceBatches: [
      {
        batchStockId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "BatchStock",
        },
        batchId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Batch",
        },
        batchNumber: {
          type: String,
          trim: true,
        },
        quantity: {
          type: Number,
          min: 1,
        },
        receivedGoodQuantity: {
          type: Number,
          default: 0,
          min: 0,
        },
        receivedDamagedQuantity: {
          type: Number,
          default: 0,
          min: 0,
        },
        receivedMissingQuantity: {
          type: Number,
          default: 0,
          min: 0,
        },
        remarks: {
          type: String,
          default: "",
        },
      },
    ],
  },
  { _id: false }
);

const transferSchema = new mongoose.Schema(
  {
    transferNumber: {
      type: String,
      unique: true,
    },
    sourceBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    sourceBranchName: {
      type: String,
      required: true,
    },
    destinationBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    destinationBranchName: {
      type: String,
      required: true,
    },
    items: [transferItemSchema],
    summary: {
      totalItems: { type: Number, default: 0 },
      totalQuantity: { type: Number, default: 0 },
      totalReceived: { type: Number, default: 0 },
      totalDamaged: { type: Number, default: 0 },
      totalMissing: { type: Number, default: 0 },
    },
    notes: {
      type: String,
      default: "",
    },
    // Direct-selection business flow, no request/approval step:
    // PROCESSING (created - items are RESERVED right here, see
    // createTransfer.controller.js) -> PACKED (pure status flag, source
    // branch has physically gathered the items) -> DISPATCHED (pure
    // status flag too - flips each reserved serial to IN_TRANSIT, a
    // ProductSerial-level physical marker, not a separate stage here) ->
    // RECEIVED (destination branch credits its own inventory).
    // CANCELLED is reachable only from
    // PROCESSING/PACKED, since nothing has physically left the source
    // branch yet at either of those stages - cancelling needs no stock
    // reversal (PROCESSING/PACKED both happen before DISPATCH, which is
    // the moment stock actually leaves - reserved immediately at
    // creation, see createTransfer.controller.js, so cancelling from
    // either of these two stages reverses that reservation).
    status: {
      type: String,
      enum: ["PROCESSING", "PACKED", "DISPATCHED", "RECEIVED", "CANCELLED"],
      default: "PROCESSING",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    createdByName: {
      type: String,
      required: true,
    },
    packedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    packedByName: {
      type: String,
      default: null,
    },
    packedAt: {
      type: Date,
      default: null,
    },
    dispatchedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    dispatchedByName: {
      type: String,
      default: null,
    },
    dispatchedAt: {
      type: Date,
      default: null,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    receivedByName: {
      type: String,
      default: null,
    },
    receivedAt: {
      type: Date,
      default: null,
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    cancelledByName: {
      type: String,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    cancellationReason: {
      type: String,
      default: "",
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedByName: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ============================================================
// INDEXES
// ============================================================
transferSchema.index({ transferNumber: 1 });
transferSchema.index({ sourceBranchId: 1, status: 1 });
transferSchema.index({ destinationBranchId: 1, status: 1 });
transferSchema.index({ status: 1, createdAt: -1 });
transferSchema.index({ createdBy: 1, createdAt: -1 });
transferSchema.index({ isDeleted: 1 });

// ============================================================
// VIRTUALS
// ============================================================
transferSchema.virtual("totalItems").get(function () {
  return this.items.length;
});

transferSchema.virtual("totalQuantity").get(function () {
  return this.items.reduce((sum, item) => sum + item.quantity, 0);
});

// ============================================================
// PRE-SAVE - keep `summary` in sync with `items[]` on every save.
// transferNumber is always set by createTransfer.controller.js before
// Transfer.create() is called (via services/documentNumber.service.js) -
// no fallback generator belongs here.
// ============================================================
transferSchema.pre("save", async function () {
  this.summary.totalItems = this.items.length;
  this.summary.totalQuantity = this.items.reduce((sum, item) => sum + item.quantity, 0);

  let totalReceived = 0;
  let totalDamaged = 0;
  let totalMissing = 0;

  this.items.forEach((item) => {
    if (item.isSerialized) {
      totalReceived += item.serials?.filter((s) => s.condition === "GOOD").length || 0;
      totalDamaged += item.serials?.filter((s) => s.condition === "DAMAGED").length || 0;
      totalMissing += item.serials?.filter((s) => s.condition === "MISSING").length || 0;
    } else {
      (item.sourceBatches || []).forEach((b) => {
        totalReceived += b.receivedGoodQuantity || 0;
        totalDamaged += b.receivedDamagedQuantity || 0;
        totalMissing += b.receivedMissingQuantity || 0;
      });
    }
  });

  this.summary.totalReceived = totalReceived;
  this.summary.totalDamaged = totalDamaged;
  this.summary.totalMissing = totalMissing;
});

transferSchema.set("toJSON", { virtuals: true });
transferSchema.set("toObject", { virtuals: true });

const Transfer = mongoose.model("Transfer", transferSchema);
export default Transfer;
