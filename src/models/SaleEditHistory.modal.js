// models/SaleEditHistory.modal.js
import mongoose from "mongoose";

// One record per successful Sale edit (updateSale.controller.js creates
// exactly one of these per save, inside the same transaction). This is
// the audit trail the Super Admin's EOD review reads to see "what
// changed" - the edit already applied to the live Sale document
// immediately, so this is the only place the before/after values
// survive for later review. Byte-for-byte structural mirror of
// PurchaseEditHistory.modal.js.
const saleEditHistorySchema = new mongoose.Schema(
  {
    saleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      required: true,
    },
    editedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    editedByRole: {
      type: String,
      default: "",
    },
    // field: a stable machine key (e.g. "customerId", "notes",
    // "item:SN123:price") - label is the human-readable version shown
    // in the UI. oldValue/newValue are intentionally Mixed since they
    // hold everything from a plain string (notes) to a nested object
    // (payment summary, complimentary checklist).
    changes: [
      {
        field: { type: String, required: true },
        label: { type: String, required: true },
        oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
        newValue: { type: mongoose.Schema.Types.Mixed, default: null },
        _id: false,
      },
    ],
  },
  {
    timestamps: true,
  }
);

saleEditHistorySchema.index({ saleId: 1, createdAt: -1 });

const SaleEditHistory = mongoose.model("SaleEditHistory", saleEditHistorySchema);

export default SaleEditHistory;
