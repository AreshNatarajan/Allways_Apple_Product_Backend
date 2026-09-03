import mongoose from "mongoose";

// Post-sale Type 2 Exchange - a customer trades in one or more old
// products AFTER a sale has already been completed, as credit against
// that sale's own remaining balance. Same concept as Sale.tradeInItems
// (see Sale.modal.js's own "TYPE 2 EXCHANGE" comment block and
// services/sale/tradeInProcessor.service.js), just triggered later from
// the Sale Detail page instead of at Sale Create time - reuses
// tradeInProcessor.service.js unchanged for the actual inventory-
// receiving side (same synthetic Purchase mechanism, source:
// "CUSTOMER_EXCHANGE").
//
// Deliberately a separate top-level collection, never an embedded array
// on Sale or a rewrite of Sale.tradeInItems - same convention
// SaleReturn/SaleExchange already established. Unlike SaleReturn/
// SaleExchange (which never touch Sale.paidAmount/pendingAmount/
// paymentStatus, keeping Sale a frozen historical snapshot), this DOES
// adjust Sale.pendingAmount/paymentStatus/tradeInCreditApplied -
// deliberate, since the whole point here is "handle payment the same
// way create-time trade-in does" (reduce what's still owed), not a
// separate untouched settlement record. See createSaleTradeIn.controller.js.
const tradeInItemSchema = new mongoose.Schema(
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
      default: false,
    },
    serialNumber: {
      type: String,
      default: "",
      trim: true,
    },
    quantity: {
      type: Number,
      default: 1,
    },
    // The agreed acquisition/exchange value entered by staff - also the
    // created ProductSerial/BatchStock's purchasePrice (future COGS
    // basis), same as Sale.tradeInItems.
    purchasePrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    sellingPrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    productSerialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductSerial",
      default: null,
    },
    batchStockId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BatchStock",
      default: null,
    },
  },
  { _id: false }
);

// Same shape as SaleExchange's own settlementDetailSchema/SaleReturn's
// refundDetailSchema - here it only ever covers the COMPANY_REFUNDS
// direction (a customer trading in never pays extra), since totalValue
// is credit given TO the customer, never something they owe.
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

const saleTradeInSchema = new mongoose.Schema(
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

    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    items: {
      type: [tradeInItemSchema],
      default: [],
    },

    // Sum of every items[] entry's purchasePrice (x quantity for
    // non-serialized) - same formula Sale.tradeInTotalValue uses.
    totalValue: {
      type: Number,
      default: 0,
      min: 0,
    },

    // The one synthetic Purchase (source: "CUSTOMER_EXCHANGE") covering
    // this event's items - see tradeInProcessor.service.js.
    tradeInPurchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      default: null,
    },

    // min(totalValue, sale.pendingAmount at the time) - the amount
    // actually credited off the sale's due. Sale.pendingAmount is
    // decremented by exactly this, and Sale.tradeInCreditApplied is
    // incremented by it too (see createSaleTradeIn.controller.js).
    appliedToPending: {
      type: Number,
      default: 0,
      min: 0,
    },

    // totalValue - appliedToPending. >0 only when the trade-in was
    // worth more than the sale still owed (e.g. an already-fully-paid
    // sale) - the customer is owed this back in cash.
    overageAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    settlementType: {
      type: String,
      enum: ["NONE", "COMPANY_REFUNDS"],
      default: "NONE",
    },

    // Empty when settlementType is "NONE" - otherwise one or more
    // entries whose amounts sum to exactly overageAmount.
    settlementDetails: {
      type: [settlementDetailSchema],
      default: [],
    },

    tradeInAt: {
      type: Date,
      default: Date.now,
    },

    // EOD (End of Day) audit-only review status - identical shape and
    // meaning to Sale.processStatus/SaleReturn.processStatus/
    // SaleExchange.processStatus. No separate review action -
    // reviewSale.controller.js's one approve/reject on the SALE
    // cascades the same decision here too.
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

saleTradeInSchema.index({ isDeleted: 1, saleId: 1 });
saleTradeInSchema.index({ isDeleted: 1, branchId: 1, createdAt: -1 });
saleTradeInSchema.index({ isDeleted: 1, processStatus: 1 });

const SaleTradeIn = mongoose.model("SaleTradeIn", saleTradeInSchema);

export default SaleTradeIn;
