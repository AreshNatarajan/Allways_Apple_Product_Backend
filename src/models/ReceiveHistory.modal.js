// models/ReceiveHistory.modal.js
import mongoose from "mongoose";

const receiveHistoryItemSchema = new mongoose.Schema({
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
  },
  isSerialized: {
    type: Boolean,
    default: false,
  },
  orderedQuantity: {
    type: Number,
    default: 0,
  },
  // ✅ Track all four outcomes
  receivedQuantity: {
    type: Number,
    default: 0,
  },
  damagedQuantity: {
    type: Number,
    default: 0,
  },
  missingQuantity: {
    type: Number,
    default: 0,
  },
  rejectedQuantity: {
    type: Number,
    default: 0,
  },
  serialNumbers: [{
    serialNumber: String,
    productSerialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductSerial",
    },
    status: {
      type: String,
      enum: ["AVAILABLE", "DAMAGED", "MISSING", "REJECTED"],
      default: "AVAILABLE",
    },
  }],
  status: {
    type: String,
    enum: ["RECEIVED", "PARTIAL", "DAMAGED", "MISSING", "REJECTED"],
    default: "RECEIVED",
  },
});

const receiveHistorySchema = new mongoose.Schema({
  purchaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Purchase",
    required: true,
  },
  purchaseNumber: {
    type: String,
    required: true,
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Branch",
    required: true,
  },
  branchName: {
    type: String,
  },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Vendor",
  },
  vendorName: {
    type: String,
  },
  items: [receiveHistoryItemSchema],
  summary: {
    totalItems: { type: Number, default: 0 },
    totalReceived: { type: Number, default: 0 },
    totalDamaged: { type: Number, default: 0 },
    totalMissing: { type: Number, default: 0 },
    totalRejected: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
  },
  receivedAt: {
    type: Date,
    required: true,
    default: Date.now,
  },
  receivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  receivedByName: {
    type: String,
  },
  notes: {
    type: String,
    default: "",
  },
  status: {
    type: String,
    enum: ["COMPLETED", "PARTIAL", "DAMAGED", "MISSING", "REJECTED"],
    default: "COMPLETED",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

receiveHistorySchema.index({ branchId: 1, receivedAt: -1 });
receiveHistorySchema.index({ purchaseId: 1 });

// ============================================================
// APPEND-ONLY ENFORCEMENT
// ============================================================
// ReceiveHistory is a permanent goods-receipt audit trail - once a
// receiving event is recorded, it must never be modified or deleted.
// These hooks block every realistic Mongoose path to update or delete
// an existing document; they cannot stop a raw MongoDB driver
// operation that bypasses Mongoose entirely (infrastructure/ops
// scope, not schema scope).

const RECEIVE_HISTORY_UPDATE_ERROR = new Error(
  "ReceiveHistory records are append-only and cannot be updated."
);
const RECEIVE_HISTORY_DELETE_ERROR = new Error(
  "ReceiveHistory records are append-only and cannot be deleted."
);

// Promise-style middleware (no `next` parameter) - Mongoose 9 removed
// callback-style hooks entirely; a `next` argument is simply never
// passed, regardless of function signature. Throwing rejects.
receiveHistorySchema.pre("updateOne", { document: false, query: true }, function () {
  throw RECEIVE_HISTORY_UPDATE_ERROR;
});
receiveHistorySchema.pre("updateMany", function () {
  throw RECEIVE_HISTORY_UPDATE_ERROR;
});
receiveHistorySchema.pre("findOneAndUpdate", function () {
  throw RECEIVE_HISTORY_UPDATE_ERROR;
});

receiveHistorySchema.pre("deleteOne", { document: false, query: true }, function () {
  throw RECEIVE_HISTORY_DELETE_ERROR;
});
receiveHistorySchema.pre("deleteMany", function () {
  throw RECEIVE_HISTORY_DELETE_ERROR;
});
receiveHistorySchema.pre("findOneAndDelete", function () {
  throw RECEIVE_HISTORY_DELETE_ERROR;
});
receiveHistorySchema.pre("deleteOne", { document: true, query: false }, function () {
  throw RECEIVE_HISTORY_DELETE_ERROR;
});

receiveHistorySchema.pre("save", function () {
  if (!this.isNew) {
    throw RECEIVE_HISTORY_UPDATE_ERROR;
  }
});

const ReceiveHistory = mongoose.model("ReceiveHistory", receiveHistorySchema);
export default ReceiveHistory;

