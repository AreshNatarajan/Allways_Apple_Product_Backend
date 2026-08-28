import mongoose from "mongoose";

// A customer returns one or more items from an already-completed Sale
// for a refund. Deliberately a separate top-level collection, never an
// embedded array on Sale - matches this app's established convention
// that every audit/history concept (StockMovement, TransferHistory,
// PurchaseEditHistory, SaleEditHistory, LoginHistory) is its own
// collection, never an unbounded array on the parent document, and
// lets this carry its own independent processStatus review lifecycle.
//
// The refund tracked here is INDEPENDENT of the original Sale's own
// paidAmount/pendingAmount/paymentStatus - the Sale stays a frozen
// historical snapshot of what was actually sold and paid at the time,
// exactly like every other financial record in this app (Purchase/Sale
// edits never rewrite the original, they log to a separate history
// instead). Profit & Loss/Dashboard integration is a deliberate,
// separately-scoped follow-up, not done here.
const saleReturnItemSchema = new mongoose.Schema(
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

    // ----------------------------------------------------------
    // SERIALIZED - a serialized line is always exactly 1 unit, and can
    // only ever be returned once (guarded at creation by checking the
    // unit's own ProductSerial.status, not by summing quantities).
    // ----------------------------------------------------------
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

    // ----------------------------------------------------------
    // NON-SERIALIZED - a batch line can be partially returned, so
    // quantity already returned against this batchId (across other
    // non-REJECTED SaleReturn docs for this same sale) is summed and
    // compared to the original line's quantity at creation time. A
    // Sale.items line has no subdocument _id (saleItemSchema is
    // `{ _id: false }`), so batchId/productSerialId - already unique
    // per line within one Sale, per Sale.modal.js's own comment - are
    // what identifies which line a return line came from, exactly like
    // updateSale.controller.js's own removedItems.serialized/
    // removedItems.nonSerialized already do.
    // ----------------------------------------------------------
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

    // sellingPrice from the original Sale.items line, frozen at return
    // time - never a live product-price lookup.
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },

    // unitPrice * quantity, server-computed - never trusted from the
    // client, matching how every other total in this app is derived.
    lineRefundAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // Serialized only - what was actually taken back from the customer
    // along with the unit itself, checked against what Sale.items[].
    // complimentary recorded as originally given (a customer may keep
    // an accessory even while returning the main item). Same shape as
    // Sale.items[].complimentary so the two are directly comparable.
    complimentaryReturned: {
      bag: { type: Boolean, default: false },
      hub: { type: Boolean, default: false },
      msOffice: { type: Boolean, default: false },
      case: { type: Boolean, default: false },
    },
  },
  { _id: false }
);

// Same shape as Sale's own paymentDetailSchema - a refund can be
// disbursed across more than one method/transaction (e.g. part cash,
// part UPI), and each entry can carry its own evidence attachment,
// exactly like a payment.
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

    attachment: {
      type: String,
      default: null,
    },

    // Who actually handled this specific refund - stamped server-side
    // from the authenticated user, never client-trusted, matching
    // Sale.paymentDetails[].handledBy exactly.
    handledBy: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      name: {
        type: String,
        default: "",
      },
      role: {
        type: String,
        default: "",
      },
    },
  },
  { _id: false }
);

const saleReturnSchema = new mongoose.Schema(
  {
    saleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      required: true,
    },

    // Denormalized for display - never re-derived from a populate on
    // every list render.
    saleNumber: {
      type: String,
      default: "",
      trim: true,
    },

    // Copied from sale.branchId at creation - whose inventory this
    // return credits back.
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    items: {
      type: [saleReturnItemSchema],
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

    // Server-computed sum of refundDetails[].amount - never trusted
    // from the client, matching how Sale.paidAmount is derived from
    // paymentDetails[].
    refundAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // The actual disbursement - one or more entries, mirroring Sale's
    // own paymentDetails[] shape/flexibility exactly (a refund can be
    // split across methods, each with its own evidence attachment).
    refundDetails: {
      type: [refundDetailSchema],
      default: [],
    },

    // EOD (End of Day) audit-only review status - identical shape and
    // meaning to Sale.processStatus. There is no separate review action
    // for a Return - reviewSale.controller.js's one approve/reject on
    // the SALE cascades the same decision to every one of its own
    // SaleReturn docs still PENDING_REVIEW, so create/edit/return/
    // (future) exchange all share that single review, never their own
    // independent one. Deliberately never re-touches stock or the
    // refund - both are already final by the time this is reviewed.
    // Stays null for a SUPER_ADMIN-created return, out of EOD review's
    // scope entirely.
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

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
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

saleReturnSchema.index({ isDeleted: 1, saleId: 1 });
saleReturnSchema.index({ isDeleted: 1, branchId: 1, createdAt: -1 });
saleReturnSchema.index({ isDeleted: 1, processStatus: 1 });

const SaleReturn = mongoose.model("SaleReturn", saleReturnSchema);

export default SaleReturn;
