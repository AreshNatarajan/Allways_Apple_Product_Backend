// models/PurchaseReturn.modal.js
import mongoose from "mongoose";

// A branch/SUPER_ADMIN sends one or more already-purchased items back
// to the vendor (e.g. the vendor asks for a specific unit back).
// Deliberately a separate top-level collection, never embedded on
// Purchase - same convention SaleReturn already established for this
// exact kind of concept.
//
// Mirrors SaleReturn's architecture exactly (per explicit direction to
// match it, not the earlier "genuine pre-apply approval gate" design):
// applies IMMEDIATELY on creation - inventory changes and the refund
// both happen right in createPurchaseReturn.controller.js's own
// transaction, never gated behind a separate approval step. The safety
// net is the SAME EOD review as everything else on this purchase -
// creating a return resets Purchase.processStatus back to
// PENDING_REVIEW (see createPurchaseReturn.controller.js), and
// reviewPurchase.controller.js's one approve/reject cascades the same
// decision to every one of its own PurchaseReturn docs still
// PENDING_REVIEW. There is no separate per-return review action.
const purchaseReturnItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    productName: {
      type: String,
      default: "",
      trim: true,
    },
    isSerialized: {
      type: Boolean,
      required: true,
    },

    // SERIALIZED - always exactly 1 unit, identified by the exact
    // original ProductSerial record (never a free-typed serial number).
    productSerialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductSerial",
      default: null,
    },
    serialNumber: {
      type: String,
      default: "",
      trim: true,
    },

    // NON-SERIALIZED - a batch line can be partially returned across
    // more than one PurchaseReturn over time.
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
    },
    batchNumber: {
      type: String,
      default: "",
      trim: true,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    // purchasePrice from the original ProductSerial/BatchStock, frozen
    // at return time - never a live lookup.
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },

    // unitPrice * quantity, server-computed - never trusted from the
    // client.
    lineReturnAmount: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { _id: false }
);

// Same shape as Purchase.paymentDetailSchema/SaleReturn.refundDetailSchema -
// a vendor refund can be disbursed across more than one method/
// transaction, each with its own evidence attachment.
const refundDetailSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    refundDate: {
      type: Date,
      default: Date.now,
    },
    refundMethod: {
      type: String,
      enum: ["CASH", "UPI", "CARD", "NET_BANKING", "CHEQUE", "EMI"],
      default: "CASH",
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    // Legacy single-file field - kept ONLY so a refund recorded before
    // multi-evidence support still reads back correctly (never written
    // to by new code; see `attachments` below, the current field).
    attachment: {
      type: String,
      default: null,
    },
    // Dynamic list of evidence files (0, 1, 2+) - same reasoning as
    // Purchase.paymentDetailSchema's own attachments[].
    attachments: {
      type: [
        {
          url: { type: String, required: true, trim: true },
          key: { type: String, default: null, trim: true },
          name: { type: String, default: "", trim: true },
          _id: false,
        },
      ],
      default: [],
    },
    handledBy: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      name: { type: String, default: "" },
      role: { type: String, default: "" },
    },
  },
  { _id: false }
);

const purchaseReturnSchema = new mongoose.Schema(
  {
    purchaseReturnNumber: {
      type: String,
      unique: true,
    },

    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      required: true,
    },
    purchaseNumber: {
      type: String,
      default: "",
      trim: true,
    },

    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: true,
    },
    vendorSnapshot: {
      name: { type: String, default: "" },
      gstNumber: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      address: { type: String, default: "" },
    },

    // The branch this return actually removes items from - for a
    // BRANCH-type Purchase this is Purchase.branchId; for a CENTRAL
    // Purchase, every item requested on one return must share the same
    // item.branchId (validated at creation - a single return never
    // spans two different branches' stock).
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    branchName: {
      type: String,
      default: "",
      trim: true,
    },

    items: {
      type: [purchaseReturnItemSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "A return must include at least one item.",
      },
    },

    reason: {
      type: String,
      required: true,
      trim: true,
    },

    // Server-computed sum of items[].lineReturnAmount - the value being
    // sent back to the vendor.
    returnAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // The refund actually received from the vendor - entered right at
    // creation time (mirrors SaleReturn.refundDetails exactly), since
    // this applies immediately alongside the inventory change, not as a
    // separate later step.
    refundAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    refundDetails: {
      type: [refundDetailSchema],
      default: [],
    },

    // EOD (End of Day) audit-only review status - identical shape and
    // meaning to Purchase.processStatus/SaleReturn.processStatus. There
    // is no separate review action for a Return - reviewPurchase.
    // controller.js's one approve/reject on the PURCHASE cascades the
    // same decision to every one of its own PurchaseReturn docs still
    // PENDING_REVIEW. Stays null for a SUPER_ADMIN-created return, out
    // of EOD review's scope entirely.
    processStatus: {
      type: String,
      enum: ["PENDING_REVIEW", "APPROVED", "REJECTED"],
      default: null,
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
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

    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

purchaseReturnSchema.index({ isDeleted: 1, purchaseId: 1 });
purchaseReturnSchema.index({ isDeleted: 1, processStatus: 1 });
purchaseReturnSchema.index({ isDeleted: 1, branchId: 1, createdAt: -1 });
purchaseReturnSchema.index({ isDeleted: 1, vendorId: 1 });

const PurchaseReturn = mongoose.model("PurchaseReturn", purchaseReturnSchema);

export default PurchaseReturn;
