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
    // PER-UNIT IDENTITY & PRICING
    // ============================================================
    // Each physical serialized unit is independent - two units of the
    // same product can legitimately differ in exact model and in the
    // price they were bought/will sell for (e.g. condition-based
    // grading on second-hand stock). These must never be assumed equal
    // across serials sharing one purchase line.
    modelNumber: {
      type: String,
      required: true,
      trim: true,
    },

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
    // Real, client-settable input tax captured once at purchase time
    // (not forced to 0) - most second-hand purchases still have no
    // input GST, but a purchase from a GST-registered dealer legitimately
    // can, so this is a genuine capture point, not a placeholder.
    purchaseGstPercent: {
      type: Number,
      default: 0,
    },
    // purchasePrice * purchaseGstPercent / 100, computed once at
    // purchase time and stored permanently alongside it - never
    // recomputed later, so a future GstConfig rate change can never
    // retroactively alter a historical unit's recorded input tax.
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
    description: {
      type: String,
      default: "",
      trim: true,
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


