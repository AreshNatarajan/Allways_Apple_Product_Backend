// models/PurchaseEditHistory.modal.js
import mongoose from "mongoose";

// One record per successful Purchase edit (updatePurchase.controller.js
// creates exactly one of these per save, inside the same transaction).
// This is the audit trail the Super Admin's EOD review reads to see
// "what changed" - the edit already applied to the live Purchase
// document immediately, so this is the only place the before/after
// values survive for later review, same idea as LoginHistory/
// vendorSnapshot elsewhere in this app.
const purchaseEditHistorySchema = new mongoose.Schema(
  {
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
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
    // field: a stable machine key (e.g. "vendorId", "notes",
    // "item:SN123:description") - label is the human-readable version
    // shown in the UI. oldValue/newValue are intentionally Mixed since
    // they hold everything from a plain string (notes) to a nested
    // object (paymentDetails summary, description {main, second}).
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

purchaseEditHistorySchema.index({ purchaseId: 1, createdAt: -1 });

const PurchaseEditHistory = mongoose.model("PurchaseEditHistory", purchaseEditHistorySchema);

export default PurchaseEditHistory;
