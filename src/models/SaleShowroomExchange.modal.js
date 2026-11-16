import mongoose from "mongoose";

// Showroom Re-Exchange (Type 2 trade-in): a customer brings back a unit
// WE previously sold and takes another product in a NEW sale. One
// immutable-by-convention history record per surrendered serial.
//
// Deliberately NOT a SaleExchange: that collection models swapping an old
// item for a new one inside ONE existing sale and its adjustment maths is
// `newItem.finalAmount - oldItem.finalAmount`. Here the unit leaves the
// ORIGINAL sale's custody and the exchange value is credited against a
// DIFFERENT, newly created sale, so neither the document shape nor the
// P&L adjustment applies. The original sale stays a frozen snapshot, as
// everywhere else in this app; ProductSerial only ever points at the
// unit's CURRENT state (saleId is cleared when it returns to stock), so
// THIS record is what preserves "which sale / purchase / line it came
// from" and the cost-basis change - never recomputed, never edited.
//
// Also not a Purchase: no Purchase and no ProductSerial is created. The
// unit keeps its original purchaseId and ProductSerial.purchasePrice;
// only ProductSerial.currentCostBasis changes (see
// services/inventory/serialCostBasis.js).
const originalSaleLineSchema = new mongoose.Schema(
  {
    // SALE_ITEM  = found in originalSale.items[]
    // SALE_EXCHANGE = the unit entered that sale through a SaleExchange
    //                 (never added to sale.items[]) - snapshot is the
    //                 exchange's newItem.
    source: { type: String, enum: ["SALE_ITEM", "SALE_EXCHANGE"], required: true },
    saleExchangeId: { type: mongoose.Schema.Types.ObjectId, ref: "SaleExchange", default: null },
    productName: { type: String, default: "", trim: true },
    modelNumber: { type: String, default: "", trim: true },
    purchasePrice: { type: Number, default: 0 },
    sellingPrice: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 },
    gstApplicable: { type: Boolean, default: false },
    gstPercent: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    hsnCode: { type: String, default: "", trim: true },
    finalAmount: { type: Number, default: 0 },
  },
  { _id: false }
);

const saleShowroomExchangeSchema = new mongoose.Schema(
  {
    // ---- the NEW sale this exchange was credited against ----
    newSaleId: { type: mongoose.Schema.Types.ObjectId, ref: "Sale", required: true },
    newSaleNumber: { type: String, default: "", trim: true },
    // Branch that received the unit (the new sale's branch).
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", required: true },
    exchangedAt: { type: Date, default: Date.now },

    // ---- the surrendered unit ----
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, default: "", trim: true },
    productSerialId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductSerial", required: true },
    serialNumber: { type: String, required: true, trim: true, uppercase: true },

    // ---- where it came from (frozen) ----
    originalSaleId: { type: mongoose.Schema.Types.ObjectId, ref: "Sale", required: true },
    originalSaleNumber: { type: String, default: "", trim: true },
    originalBranchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null },
    originalSoldAt: { type: Date, default: null },
    originalCustomerName: { type: String, default: "", trim: true },
    originalPurchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", required: true },
    originalSaleLine: { type: originalSaleLineSchema, required: true },

    // ---- money / cost basis ----
    // Staff-entered, condition-based value credited against the new sale.
    // = "Current Value" (user-facing Replacement credit AND the unit's new
    // cost basis). Kept under this name for existing records.
    exchangeValue: { type: Number, required: true, min: 0 },
    // "Sale Value": the new intended selling price set on the returned
    // unit (ProductSerial.sellingPrice). Independent of exchangeValue.
    // Records created before this field existed simply have no value.
    saleValue: { type: Number, default: null, min: 0 },
    // ProductSerial.sellingPrice before this replacement overwrote it.
    previousSellingPrice: { type: Number, default: null, min: 0 },
    // ProductSerial.purchasePrice at the time - never changed by this.
    originalPurchasePrice: { type: Number, default: 0, min: 0 },
    // Effective cost before / after this exchange (null-safe numbers).
    previousCostBasis: { type: Number, default: 0, min: 0 },
    newCostBasis: { type: Number, default: 0, min: 0 },

    conditionNote: { type: String, default: "", trim: true, maxlength: 1000 },

    // Same review lifecycle as SaleReturn/SaleExchange. Audit status
    // never changes stock or figures (Phase 1 rule); there is no
    // cancellation workflow.
    processStatus: {
      type: String,
      enum: ["PENDING_REVIEW", "APPROVED", "REJECTED"],
      default: null,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// A unit can be exchanged out of a given sale only once. It may come back
// again later from a DIFFERENT sale (after being sold again).
saleShowroomExchangeSchema.index(
  { originalSaleId: 1, productSerialId: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
saleShowroomExchangeSchema.index({ newSaleId: 1, isDeleted: 1 });
saleShowroomExchangeSchema.index({ productSerialId: 1, exchangedAt: -1 });
saleShowroomExchangeSchema.index({ isDeleted: 1, branchId: 1, createdAt: -1 });
saleShowroomExchangeSchema.index({ isDeleted: 1, processStatus: 1 });

const SaleShowroomExchange = mongoose.model("SaleShowroomExchange", saleShowroomExchangeSchema);

export default SaleShowroomExchange;
