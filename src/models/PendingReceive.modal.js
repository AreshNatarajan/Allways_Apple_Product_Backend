// models/PendingReceive.modal.js
import mongoose from "mongoose";

const pendingReceiveItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productName: {
      type: String,
      default: "",
    },
    // The Batch this ordered quantity belongs to. Created up front at
    // CENTRAL purchase time (not at receive time) so a barcode label
    // can be printed and applied to the physical stock before it ships
    // out. The same batchId can legitimately appear on PendingReceive
    // rows for more than one branch when a single purchased lot is
    // split across several destinations - receive-time activates a
    // BatchStock row for {batchId, branchId} rather than minting a new
    // batch number per branch. Optional/unset on any PendingReceive
    // document created before this field existed.
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
    },
    batchNumber: {
      type: String,
      default: "",
    },
    orderedQuantity: {
      type: Number,
      required: true,
      min: 1,
    },
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
    // Reported missing at receive time (short-shipped / lost in
    // transit) - distinct from DAMAGED (physically present but unfit)
    // and REJECTED (refused back to vendor).
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
    status: {
      type: String,
      enum: ["PENDING", "PARTIAL", "RECEIVED", "DAMAGED", "MISSING", "REJECTED"],
      default: "PENDING",
    },
    // Free-text reason captured whenever a receive on this line records
    // any damaged/missing/rejected quantity - never set for a fully
    // good receive.
    remarks: {
      type: String,
      default: "",
      trim: true,
    },
    // Who/when this line's status was last changed by a receive event.
    statusUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    statusUpdatedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  }
);

// PendingReceive is scoped to NON-SERIALIZED purchase lines only.
// Serialized "pending" state is fully and correctly represented by
// ProductSerial.status (ASSIGNED -> AVAILABLE) - a serialized item
// never needs a PendingReceive entry of its own. (The two fields
// previously here - receivedSerialNumbers[] and an embedded
// receiveHistory[] - were confirmed dead: written once at purchase
// time and never read/updated again; the real receiving audit trail
// is the separate top-level ReceiveHistory collection. Confirmed zero
// PendingReceive documents exist in the live database at the time of
// this change, so there is no historical data at risk.)

const pendingReceiveSchema = new mongoose.Schema(
  {
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      required: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    // ✅ Removed branchName - use populate to get branch details
    items: [pendingReceiveItemSchema],
    status: {
      type: String,
      enum: ["PENDING", "PARTIAL", "COMPLETED", "DAMAGED", "MISSING", "REJECTED"],
      default: "PENDING",
    },
    receivedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    completedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// ============================================================
// INDEXES
// ============================================================
// One PendingReceive per {purchaseId, branchId} in practice (enforced
// by application logic at creation, not a hard unique constraint here)
// - both the list and detail/receive controllers look up by this pair
// constantly.
pendingReceiveSchema.index({ purchaseId: 1, branchId: 1 });
// Branch-scoped list filtering/sorting by status - the Pending Receive
// list's primary query shape.
pendingReceiveSchema.index({ branchId: 1, status: 1 });

const PendingReceive = mongoose.model("PendingReceive", pendingReceiveSchema);

export default PendingReceive;


