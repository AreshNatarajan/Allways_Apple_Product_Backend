// models/TransferHistory.model.js
import mongoose from "mongoose";

const transferHistorySchema = new mongoose.Schema(
  {
    transferId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transfer",
      required: true,
    },
    transferNumber: {
      type: String,
      required: true,
    },
    // Direct-selection business flow action set - no ACCEPTED/COMPLETED
    // (request/approval concept removed), no IN_TRANSIT (DISPATCHED
    // already means "left the source branch" - a separate stage for
    // "en route" was redundant with it).
    action: {
      type: String,
      enum: [
        "CREATED",
        "PACKED",
        "DISPATCHED",
        "RECEIVED",
        "CANCELLED",
        "DELETED",
      ],
      required: true,
    },
    fromStatus: {
      type: String,
      enum: ["PROCESSING", "PACKED", "DISPATCHED", "RECEIVED", "CANCELLED"],
      default: null,
    },
    toStatus: {
      type: String,
      enum: ["PROCESSING", "PACKED", "DISPATCHED", "RECEIVED", "CANCELLED"],
      default: null,
    },
    // ✅ Track which items were affected
    affectedItems: [
      {
        productId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
        },
        productName: {
          type: String,
        },
        quantity: {
          type: Number,
          default: 0,
        },
        serials: [String],
      },
    ],
    notes: {
      type: String,
      default: "",
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    performedByName: {
      type: String,
      required: true,
    },
    performedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// ✅ Indexes for performance
transferHistorySchema.index({ transferId: 1, performedAt: -1 });
transferHistorySchema.index({ transferNumber: 1 });
transferHistorySchema.index({ performedBy: 1, performedAt: -1 });
transferHistorySchema.index({ action: 1, performedAt: -1 });

// ✅ Static method to log history
transferHistorySchema.statics.logHistory = async function({
  transfer,
  action,
  fromStatus,
  toStatus,
  notes = "",
  performedBy,
  performedByName,
  affectedItems = [],
}) {
  return this.create({
    transferId: transfer._id,
    transferNumber: transfer.transferNumber,
    action,
    fromStatus,
    toStatus,
    notes,
    performedBy,
    performedByName,
    affectedItems,
  });
};

// ✅ Instance method for UI formatting
transferHistorySchema.methods.getFormattedHistory = function() {
  const actionLabels = {
    CREATED: "Created",
    PACKED: "Packed",
    DISPATCHED: "Dispatched",
    RECEIVED: "Received",
    CANCELLED: "Cancelled",
    DELETED: "Deleted",
  };

  return {
    _id: this._id,
    action: this.action,
    actionLabel: actionLabels[this.action] || this.action,
    fromStatus: this.fromStatus,
    toStatus: this.toStatus,
    performedBy: this.performedByName,
    performedAt: this.performedAt,
    notes: this.notes,
    affectedItems: this.affectedItems,
    isStatusChange: this.fromStatus !== this.toStatus,
  };
};

// ============================================================
// APPEND-ONLY ENFORCEMENT
// ============================================================
// TransferHistory is a permanent transfer-lifecycle audit trail -
// once a state transition is recorded, it must never be modified or
// deleted. These hooks block every realistic Mongoose path to update
// or delete an existing document; they cannot stop a raw MongoDB
// driver operation that bypasses Mongoose entirely (infrastructure/
// ops scope, not schema scope). Creation via the logHistory() static
// above uses .create(), which is unaffected (isNew is true for a
// genuinely new document).

const TRANSFER_HISTORY_UPDATE_ERROR = new Error(
  "TransferHistory records are append-only and cannot be updated."
);
const TRANSFER_HISTORY_DELETE_ERROR = new Error(
  "TransferHistory records are append-only and cannot be deleted."
);

// Promise-style middleware (no `next` parameter) - Mongoose 9 removed
// callback-style hooks entirely; a `next` argument is simply never
// passed, regardless of function signature. Throwing rejects.
transferHistorySchema.pre("updateOne", { document: false, query: true }, function () {
  throw TRANSFER_HISTORY_UPDATE_ERROR;
});
transferHistorySchema.pre("updateMany", function () {
  throw TRANSFER_HISTORY_UPDATE_ERROR;
});
transferHistorySchema.pre("findOneAndUpdate", function () {
  throw TRANSFER_HISTORY_UPDATE_ERROR;
});

transferHistorySchema.pre("deleteOne", { document: false, query: true }, function () {
  throw TRANSFER_HISTORY_DELETE_ERROR;
});
transferHistorySchema.pre("deleteMany", function () {
  throw TRANSFER_HISTORY_DELETE_ERROR;
});
transferHistorySchema.pre("findOneAndDelete", function () {
  throw TRANSFER_HISTORY_DELETE_ERROR;
});
transferHistorySchema.pre("deleteOne", { document: true, query: false }, function () {
  throw TRANSFER_HISTORY_DELETE_ERROR;
});

transferHistorySchema.pre("save", function () {
  if (!this.isNew) {
    throw TRANSFER_HISTORY_UPDATE_ERROR;
  }
});

const TransferHistory = mongoose.model("TransferHistory", transferHistorySchema);
export default TransferHistory;

