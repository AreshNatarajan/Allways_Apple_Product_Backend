import mongoose from "mongoose";

// A customer swaps an already-sold serialized unit for a different
// available one, phase 1: serialized only, exactly one old item for one
// new item. Deliberately a separate top-level collection, never an
// embedded array on Sale or a rewrite of the original Sale.items line -
// same convention SaleReturn already established (see that file's own
// comment). The Sale document itself is never touched beyond its EOD
// review fields (processStatus/reviewedBy/reviewedAt reset, mirroring
// how a Return already resets them) - no items/totals write, ever.
//
// oldItem/newItem both freeze their sellingPrice (and the rest of their
// pricing/tax metadata) at exchange time, so a later change to the
// product's live price can never retroactively alter exchange history.
const exchangeItemSchema = new mongoose.Schema(
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

    productCode: {
      type: String,
      default: "",
      trim: true,
    },

    modelNumber: {
      type: String,
      default: "",
      trim: true,
    },

    productSerialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductSerial",
      required: true,
    },

    serialNumber: {
      type: String,
      default: "",
      trim: true,
    },

    // Frozen at exchange time - oldItem from the original Sale line,
    // newItem from the picked replacement unit's own ProductSerial
    // fields. Never a live lookup afterward.
    purchasePrice: {
      type: Number,
      default: 0,
      min: 0,
    },

    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
    },

    // Mirrors Sale.modal.js's saleItemSchema pricing fields exactly, so
    // both oldItem and newItem carry a complete Sale-Entry-equivalent
    // snapshot (discount applied, GST on margin, final amount) rather
    // than just a bare selling price.
    discount: {
      type: Number,
      default: 0,
      min: 0,
    },

    subtotal: {
      type: Number,
      default: 0,
      min: 0,
    },

    gstApplicable: {
      type: Boolean,
      default: false,
    },

    gstPercent: {
      type: Number,
      default: 0,
      min: 0,
    },

    gstAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    hsnCode: {
      type: String,
      default: "",
      trim: true,
    },

    finalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Same shape as Sale.modal.js's saleItemSchema.complimentary -
    // serialized-only accessory checklist, frozen at exchange time.
    complimentary: {
      bag: { type: Boolean, default: false },
      hub: { type: Boolean, default: false },
      msOffice: { type: Boolean, default: false },
      case: { type: Boolean, default: false },
    },
  },
  { _id: false }
);

// Same shape as SaleReturn's own refundDetailSchema - one array covers
// either settlement direction (customer pays extra, or the company
// refunds the difference); settlementType on the parent doc says which.
const settlementDetailSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    date: {
      type: Date,
      default: Date.now,
    },

    method: {
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

    // Stamped server-side from the authenticated user, never
    // client-trusted, matching SaleReturn.refundDetails[].handledBy.
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

const saleExchangeSchema = new mongoose.Schema(
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

    // Copied from sale.branchId at creation - whose inventory both
    // stock movements (old unit back in, new unit out) apply against.
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    oldItem: {
      type: exchangeItemSchema,
      required: true,
    },

    newItem: {
      type: exchangeItemSchema,
      required: true,
    },

    // newItem.finalAmount - oldItem.finalAmount, server-computed - never
    // trusted from the client. finalAmount already nets out each side's
    // own discount, so this is an apples-to-apples comparison, not a
    // raw sellingPrice diff.
    priceDifference: {
      type: Number,
      required: true,
    },

    // Derived from priceDifference's sign at creation time - positive
    // means the customer owes more, negative means the company owes a
    // refund, zero means no money changes hands.
    settlementType: {
      type: String,
      enum: ["CUSTOMER_PAYS", "COMPANY_REFUNDS", "NONE"],
      required: true,
    },

    // Empty when settlementType is "NONE" - otherwise one or more
    // entries whose amounts sum to exactly Math.abs(priceDifference).
    settlementDetails: {
      type: [settlementDetailSchema],
      default: [],
    },

    exchangedAt: {
      type: Date,
      default: Date.now,
    },

    // EOD (End of Day) audit-only review status - identical shape and
    // meaning to Sale.processStatus / SaleReturn.processStatus. No
    // separate review action - reviewSale.controller.js's one
    // approve/reject on the SALE cascades the same decision here too
    // (create/edit/return/exchange all share that single review).
    // Deliberately never re-touches stock or the settlement - both are
    // already final by the time this is reviewed. Stays null for a
    // SUPER_ADMIN-created exchange, out of EOD review's scope entirely.
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

saleExchangeSchema.index({ isDeleted: 1, saleId: 1 });
saleExchangeSchema.index({ isDeleted: 1, branchId: 1, createdAt: -1 });
saleExchangeSchema.index({ isDeleted: 1, processStatus: 1 });

const SaleExchange = mongoose.model("SaleExchange", saleExchangeSchema);

export default SaleExchange;
