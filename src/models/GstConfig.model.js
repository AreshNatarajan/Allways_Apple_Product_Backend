// models/GstConfig.model.js
import mongoose from "mongoose";

// Single-document settings pattern. Configured GST rates, read
// server-side at sale time instead of trusting a client-supplied
// percentage - closes the same trust-boundary gap as the persisted
// gstApplicable toggle, for the rate half of the same decision.
//
// Global, not branch-specific: GST rates are a tax-law fact, not a
// per-branch business choice - nothing elsewhere in this schema
// (Branch, Purchase, Sale) models GST as branch-dependent.
//
// "New transactions use current settings. Old transactions always use
// stored snapshots." - every Purchase/Sale/ProductSerial/Batch/
// BatchStock document that captures a GST rate does so as its OWN
// permanent field at the moment of that transaction (see
// ProductSerial.purchaseGstAmount, Sale.items[].gstPercent, etc) -
// nothing ever re-reads this config for a historical record, so
// editing a rate here can never retroactively change a past
// transaction's numbers.
const gstConfigSchema = new mongoose.Schema(
  {
    // =========================
    // INVOICE TEXT
    // =========================
    // Company identity (name/address/GSTIN) is deliberately not stored
    // here - not needed by this app.
    invoiceSettings: {
      footerNote: { type: String, default: "", trim: true },
      termsAndConditions: { type: String, default: "", trim: true },
    },

    // =========================
    // GLOBAL APPLICATION SETTINGS
    // (currency / document prefixes / stock thresholds / invoice color)
    // =========================

    // Single application-wide currency. `code` drives validation
    // against SUPPORTED_CURRENCIES (see updateGstConfig.controller.js);
    // `symbol` is stored alongside so the frontend never has to ship
    // its own code->symbol map.
    currency: {
      code: { type: String, default: "INR", uppercase: true, trim: true },
      symbol: { type: String, default: "₹", trim: true },
    },

    // Purchase/Sale/Transfer document-number prefixes. Read by the
    // shared number generator (services/documentNumber.service.js) at
    // the moment a NEW document is created - changing a prefix here
    // never touches already-generated numbers, since those are
    // permanent fields on their own Purchase/Sale/Transfer documents.
    documentPrefixes: {
      purchase: { type: String, default: "PUR", trim: true, uppercase: true },
      sale: { type: String, default: "SAL", trim: true, uppercase: true },
      transfer: { type: String, default: "TRF", trim: true, uppercase: true },
    },

    // Low-stock thresholds, independently configurable per product
    // type since serialized (unit-count) and non-serialized (batch
    // quantity) stock behave very differently at small numbers.
    inventory: {
      serializedLowStockThreshold: { type: Number, default: 5, min: 0 },
      nonSerializedLowStockThreshold: { type: Number, default: 5, min: 0 },
    },

    // Invoice header color for NEW invoice generation only (see
    // services/purchase/generatePurchaseInvoicePdf.js) - historical
    // invoices already stored in S3 are frozen PDFs and are never
    // regenerated, so this can never retroactively change one.
    invoice: {
      headerColor: { type: String, default: "#1E3C96", trim: true, uppercase: true },
    },

    // =========================
    // GST RATES
    // =========================

    // The full set of GST percentages selectable at purchase time
    // (e.g. a dropdown of standard slabs) - a reference list, not a
    // rule; any purchase-time GST percent is still validated
    // independently by its own controller, not against this list.
    availableGstRates: {
      type: [Number],
      default: [0, 5, 12, 18, 28],
    },

    // Rate applied to margin (sellingPrice - purchasePrice) for
    // GST-applicable serialized (second-hand) sales - read fresh at
    // the moment of each sale (see createSale.controller.js).
    marginSchemeRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    // Dual role: (1) default/suggested rate surfaced when selecting GST
    // for a non-serialized PURCHASE - genuinely captured per-batch at
    // that moment (Batch/BatchStock.purchaseGstPercent), this is only a
    // starting suggestion there. (2) the authoritative rate charged on
    // a non-serialized SALE - read fresh at the moment of each sale
    // (see createSale.controller.js), same "current settings, not a
    // frozen snapshot" rule already used for marginSchemeRate on the
    // serialized side. A non-serialized sale never reuses the batch's
    // own purchaseGstPercent, since the government can change the GST
    // rate on goods at any time between purchase and sale.
    standardRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const GstConfig = mongoose.model("GstConfig", gstConfigSchema);

export default GstConfig;
