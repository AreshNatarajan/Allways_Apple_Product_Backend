// models/ProductSerial.modal.js
import mongoose from "mongoose";

const productSerialSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      required: true,
    },

    // Copied from Purchase.source at creation - see Purchase.modal.js's
    // comment for the full rationale. Lets this physical unit's own
    // record identify whether it came from a real vendor purchase or a
    // Type 2 Exchange customer trade-in, not just its Purchase ancestor.
    source: {
      type: String,
      enum: ["VENDOR_PURCHASE", "CUSTOMER_EXCHANGE"],
      default: "VENDOR_PURCHASE",
    },
    serialNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    // Current branch where the serial is physically located
    currentBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
    // Assigned branch (for pending receive/transfer)
    assignedBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
    status: {
      type: String,
      enum: [
        "AVAILABLE",    // Received at branch, ready for sale
        "ASSIGNED",     // Assigned to branch, waiting for receive
        "RESERVED",     // Packed for an outbound branch-to-branch transfer, still physically at the source branch, not yet dispatched
        "IN_TRANSIT",   // Dispatched in a branch-to-branch transfer, not yet received
        "SOLD",         // Sold
        "DAMAGED",      // Damaged
        "MISSING",      // Reported missing at receive time (never entered available stock)
      ],
      default: "ASSIGNED",
    },

    // ============================================================
    // PER-UNIT PRICING
    // ============================================================
    // Each physical serialized unit is independent - two units of the
    // same product can legitimately differ in the price they were
    // bought/will sell for (e.g. condition-based grading on second-hand
    // stock). These must never be assumed equal across serials sharing
    // one purchase line.
    //
    // Model Number is deliberately NOT stored here - it always comes
    // live from Product.modelNumber (the master), so a correction to
    // the master is instantly reflected on every unit with no
    // possibility of drift. A per-unit copy used to exist but was
    // removed: nothing on the frontend ever actually let it diverge
    // from the master (every entry/edit table only ever displayed it
    // read-only, auto-filled from the selected product), so the
    // "flexibility" was unused complexity that just went stale whenever
    // the master was corrected.
    purchasePrice: {
      type: Number,
      required: true,
      min: 0,
    },

    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
    },

    // ============================================================
    // GST (purchase-time decision, persisted so Sale never has to
    // trust a client-supplied value)
    // ============================================================
    // Second-hand serialized products carry no purchase-time GST -
    // this is a manual per-unit toggle set when the purchase is
    // entered, deciding whether GST is charged when THIS specific
    // unit is later sold. Never means sale-eligibility, internal-use,
    // or anything about the customer - only whether GST applies.
    gstApplicable: {
      type: Boolean,
      default: false,
    },
    // Second-hand serialized purchases never carry an input GST value -
    // createPurchase.controller.js always writes 0 here for every
    // serialized unit, regardless of client input. GST on a serialized
    // unit is margin-scheme, computed only at sale time from
    // (sellingPrice - purchasePrice) x the current global rate (see
    // createSale.controller.js) - it is never a purchase-time input tax
    // the way it genuinely is for BatchStock's non-serialized purchases.
    // Fields kept (not removed) only for historical records created
    // before this rule, and for schema-shape parity with BatchStock.
    purchaseGstPercent: {
      type: Number,
      default: 0,
    },
    purchaseGstAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // HSN/SAC as it was on the Product master at the moment this unit
    // was purchased - a permanent snapshot (same pattern as
    // vendorSnapshot/customerSnapshot elsewhere), so a later edit to
    // the product's HSN never rewrites this unit's own historical record.
    hsnCode: {
      type: String,
      default: "",
      trim: true,
    },

    // ============================================================
    // PER-UNIT DESCRIPTION & IMAGES (source of truth for a serialized
    // physical unit)
    // ============================================================
    // Every serialized unit is an independent physical item - condition,
    // cosmetic notes, and photos genuinely differ unit-to-unit even for
    // the same Product/model (e.g. one has a scratch, another doesn't).
    // Product.description/Product.images remain correct ONLY for
    // non-serialized products (shared across every batch); they are
    // NEVER the source of truth for a serialized unit - this is that
    // source of truth instead. Entered at Purchase time (see
    // createPurchase.controller.js), one row per physical unit.
    // Two free-text slots per unit - main (primary condition/cosmetic
    // note) and second (supplementary note) - both customer-relevant,
    // entered together via the same Purchase Entry description modal.
    description: {
      main: { type: String, default: "", trim: true },
      second: { type: String, default: "", trim: true },
    },

    // Self-contained per-image objects (not parallel arrays like
    // Product.images/imageKeys) - deliberately chosen so a single image
    // can be added/removed without keeping two arrays index-synced,
    // since this array is edited more dynamically (add/remove one at a
    // time via the Purchase Entry image modal) than Product's. Same S3
    // architecture as Product images (putObject/deleteObject) - never
    // raw/base64 image data stored in Mongo. Genuinely dynamic length:
    // 0, 1, 2, 10+ images, no fixed image1/image2/image3 slots.
    images: {
      type: [
        {
          url: { type: String, required: true, trim: true },
          key: { type: String, required: true, trim: true },
          name: { type: String, default: "", trim: true },
          _id: false,
        },
      ],
      default: [],
    },

    // Separate from `description` above by design - description is
    // meant as the unit's condition/cosmetic note (customer-relevant,
    // e.g. "small scratch"), notes is free-form internal/staff-facing
    // text (e.g. "warranty transferred from previous owner", "customer
    // requested faster shipping") - two distinct fields, not aliases of
    // each other. Same per-unit ownership rule as description/images:
    // entered at Purchase time, one row per physical unit, never a
    // Product-level field.
    notes: {
      type: String,
      default: "",
      trim: true,
    },

    // Per-unit checkbox toggle, entered at Purchase time alongside
    // description/images/notes above - same ownership rule (this
    // physical unit's own record, never a Product-level field).
    mdm: {
      type: Boolean,
      default: false,
    },

    // Output GST (margin-scheme) is NOT decided or stored at purchase
    // time - it's a different concept from purchaseGstPercent above,
    // read fresh from GstConfig.marginSchemeRate at the moment of sale
    // and stamped onto the Sale document itself (Sale.items[].gstPercent),
    // never onto this record. This field is intentionally left
    // unpopulated/vestigial as of the GST redesign - createSale no
    // longer reads it (see createSale.controller.js).
    saleGstPercent: {
      type: Number,
      default: 0,
    },

    soldAt: {
      type: Date,
      default: null,
    },
    saleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sale",
      default: null,
    },
    transferredAt: {
      type: Date,
      default: null,
    },
    receivedAt: {
      type: Date,
      default: null,
    },
    // ============================================================
    // RECEIVE CONDITION AUDIT (DAMAGED / MISSING)
    // ============================================================
    // Free-text reason captured at receive time when this unit is
    // marked DAMAGED or MISSING instead of AVAILABLE - never set for a
    // GOOD receive.
    remarks: {
      type: String,
      default: "",
      trim: true,
    },
    // Who/when recorded the current status (GOOD/DAMAGED/MISSING) at
    // receive time - separate from receivedAt so a future correction
    // (via a new movement, never an edit) still has its own trail.
    conditionUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    conditionUpdatedAt: {
      type: Date,
      default: null,
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
// A physical serial number must be globally unique, not just unique
// within one purchase - two different purchases legitimately
// referencing the same real-world hardware serial is a data-entry
// error the database should reject, not silently allow. Partial on
// isDeleted:false so a soft-deleted record's serial doesn't
// permanently block reuse (matches this project's established
// soft-delete convention).
productSerialSchema.index(
  { serialNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  }
);

// Keep these for query performance (no explicit indexes per requirement)
// productSerialSchema.index({ productId: 1, status: 1 });
// productSerialSchema.index({ currentBranchId: 1, status: 1 });
// productSerialSchema.index({ purchaseId: 1 });

// Powers the Pending Receive list's serialized-side aggregation (grouped
// by purchase + assigned branch) and the receive-detail/validation
// lookups (purchase + branch scoped serial fetch) - added for the
// Pending Receive backend enhancement.
productSerialSchema.index({ purchaseId: 1, assignedBranchId: 1 });

const ProductSerial = mongoose.model("ProductSerial", productSerialSchema);

export default ProductSerial;


