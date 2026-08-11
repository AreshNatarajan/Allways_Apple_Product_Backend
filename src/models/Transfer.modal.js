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
    // Requested quantity (set once at creation, never changed afterward -
    // packing/receiving progress is tracked against this fixed target).
    quantity: {
      type: Number,
      default: 1,
      min: 1,
    },
    // Populated during Phase 2 packing (never at request time - Phase 1
    // only ever collects a quantity, per the "do not display individual
    // serial numbers yet" rule). Each entry here IS a physically packed
    // unit.
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
        isPacked: {
          type: Boolean,
          default: false,
        },
        packedAt: {
          type: Date,
          default: null,
        },
        // Set only once this specific unit has actually been received at
        // the destination - null while still in transit.
        condition: {
          type: String,
          enum: ["GOOD", "DAMAGED", "MISSING", null],
          default: null,
        },
        remarks: {
          type: String,
          default: "",
        },
        isReceived: {
          type: Boolean,
          default: false,
        },
        isRejected: {
          type: Boolean,
          default: false,
        },
        notes: {
          type: String,
          default: "",
        },
      },
    ],
    // ============================================================
    // NON-SERIALIZED PACK/RECEIVE TRACKING
    // ============================================================
    // Running total packed so far (Phase 2) - never exceeds `quantity`.
    packedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Which real BatchStock rows the packed quantity was actually taken
    // from at the source branch - needed so receiving can credit the
    // exact same batch identity at the destination branch.
    packedBatches: [
      {
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
        // Per-batch Phase 3 progress - "Arrived Qty <= Packed Qty" is
        // validated against THIS specific batch's own packed quantity,
        // not the item total, since one item can be packed from more
        // than one batch.
        receivedQuantity: {
          type: Number,
          default: 0,
          min: 0,
        },
        damagedQuantity: {
          type: Number,
          default: 0,
          min: 0,
        },
        missingQuantity: {
          type: Number,
          default: 0,
          min: 0,
        },
      },
    ],
    // Phase 3 outcome buckets - receivedQuantity is GOOD only (matches
    // the Pending Receive module's identical convention), damaged/missing
    // are new, rejectedQuantity is kept for backward compatibility with
    // any already-stored documents/virtuals.
    receivedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    damagedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    missingQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    rejectedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
    rejectedReason: {
      type: String,
      default: "",
    },
    remarks: {
      type: String,
      default: "",
    },
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
      totalPacked: { type: Number, default: 0 },
      totalReceived: { type: Number, default: 0 },
      totalDamaged: { type: Number, default: 0 },
      totalMissing: { type: Number, default: 0 },
      totalRejected: { type: Number, default: 0 },
    },
    reason: {
      type: String,
      enum: [
        "STOCK_TRANSFER",
        "CUSTOMER_REQUEST",
        "BRANCH_REPLENISHMENT",
        "DAMAGE_REPLACEMENT",
        "URGENT_REQUIREMENT",
        "OTHER",
      ],
      default: "STOCK_TRANSFER",
    },
    reasonText: {
      type: String,
      default: "",
    },
    notes: {
      type: String,
      default: "",
    },
    // Final business flow: REQUESTED -> ACCEPTED -> PACKED -> DISPATCHED
    // -> COMPLETED, or CANCELLED from any non-terminal state. RECEIVED is
    // kept in the enum only for backward compatibility with any
    // already-stored documents - new code always resolves a completed
    // receive straight to COMPLETED (see receiveTransfer.controller.js).
    status: {
      type: String,
      enum: ["REQUESTED", "ACCEPTED", "PACKED", "DISPATCHED", "RECEIVED", "COMPLETED", "CANCELLED"],
      default: "REQUESTED",
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
    // Which branch this request "belongs to" for the My Requests /
    // Other Requests split - the requesting user's own branch at
    // creation time (for SUPER_ADMIN, who has no branch of their own,
    // this is the destination branch, i.e. whichever branch the stock
    // is actually being requested for). Never recomputed from source/
    // destination later - fixed at creation like createdBy itself.
    createdByBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
    createdByBranchName: {
      type: String,
      default: null,
    },
    // ✅ ACCEPTED by (NEW)
    acceptedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    acceptedByName: {
      type: String,
      default: null,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    // Packed by (source branch, Phase 2 completion)
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
    // ✅ DISPATCHED by
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
    // ✅ RECEIVED by (NEW - replaces completedBy)
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
    // ✅ CANCELLED by
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

// ✅ Indexes
transferSchema.index({ transferNumber: 1 });
transferSchema.index({ sourceBranchId: 1, status: 1 });
transferSchema.index({ destinationBranchId: 1, status: 1 });
transferSchema.index({ status: 1, createdAt: -1 });
transferSchema.index({ createdBy: 1, createdAt: -1 });
transferSchema.index({ isDeleted: 1 });

// ✅ Virtual fields
transferSchema.virtual("totalItems").get(function () {
  return this.items.length;
});

transferSchema.virtual("totalQuantity").get(function () {
  return this.items.reduce((sum, item) => sum + item.quantity, 0);
});

transferSchema.virtual("totalReceived").get(function () {
  return this.items.reduce((sum, item) => {
    if (item.isSerialized) {
      return sum + (item.serials?.filter(s => s.isReceived).length || 0);
    }
    return sum + (item.receivedQuantity || 0);
  }, 0);
});

transferSchema.virtual("totalRejected").get(function () {
  return this.items.reduce((sum, item) => {
    if (item.isSerialized) {
      return sum + (item.serials?.filter(s => s.isRejected).length || 0);
    }
    return sum + (item.rejectedQuantity || 0);
  }, 0);
});

// ✅ PRE-SAVE MIDDLEWARE
// Number generation lives solely in createTransfer.controller.js (via
// services/documentNumber.service.js, prefix read from Global
// Settings) - transferNumber is always set before Transfer.create() is
// called, so no fallback generator belongs here. A stray duplicate
// used to live in this hook, hardcoding "TRF-" and bypassing the
// configurable prefix entirely; removed since it was dead code that
// only ever wrote to a required field the controller already sets.
transferSchema.pre("save", async function () {
  // ✅ Update summary
  this.summary.totalItems = this.items.length;
  this.summary.totalQuantity = this.items.reduce((sum, item) => sum + item.quantity, 0);

  let totalPacked = 0;
  let totalReceived = 0;
  let totalDamaged = 0;
  let totalMissing = 0;
  let totalRejected = 0;

  this.items.forEach(item => {
    if (item.isSerialized) {
      totalPacked += item.serials?.filter(s => s.isPacked).length || 0;
      totalReceived += item.serials?.filter(s => s.condition === "GOOD").length || 0;
      totalDamaged += item.serials?.filter(s => s.condition === "DAMAGED").length || 0;
      totalMissing += item.serials?.filter(s => s.condition === "MISSING").length || 0;
      totalRejected += item.serials?.filter(s => s.isRejected).length || 0;
    } else {
      totalPacked += item.packedQuantity || 0;
      totalReceived += item.receivedQuantity || 0;
      totalDamaged += item.damagedQuantity || 0;
      totalMissing += item.missingQuantity || 0;
      totalRejected += item.rejectedQuantity || 0;
    }
  });

  this.summary.totalPacked = totalPacked;
  this.summary.totalReceived = totalReceived;
  this.summary.totalDamaged = totalDamaged;
  this.summary.totalMissing = totalMissing;
  this.summary.totalRejected = totalRejected;
});

// ✅ Ensure virtuals are included in JSON output
transferSchema.set("toJSON", { virtuals: true });
transferSchema.set("toObject", { virtuals: true });

const Transfer = mongoose.model("Transfer", transferSchema);
export default Transfer;


