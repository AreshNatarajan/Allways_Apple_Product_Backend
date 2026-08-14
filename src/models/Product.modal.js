import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
  {
    // =========================
    // BASIC PRODUCT INFO
    // =========================
    // Always stored uppercase - same pattern as modelNumber below, kept
    // consistent so product names never differ only by casing (e.g.
    // "iPhone 15" vs "IPHONE 15" silently becoming two visually-similar
    // but distinct-looking entries).
    name: {
      type: String,
      required: true,
      trim: true,
      set: function (value) {
        return typeof value === "string" ? value.trim().toUpperCase() : value;
      },
    },

    category: {
      type: String,
      required: true,
      enum: ["ACCESSORY", "MOBILE", "LAPTOP", "TAB"],
    },

    // ============================================================
    // description / images - SOURCE OF TRUTH FOR NON-SERIALIZED
    // PRODUCTS ONLY.
    // ============================================================
    // For a non-serialized product these describe the product in
    // general and are correctly shared across every batch/BatchStock of
    // it - never duplicate them onto BatchStock.
    //
    // For a SERIALIZED product (isSerialized: true), these fields are
    // NOT the source of truth for an individual physical unit - each
    // unit's own description/photos live on ProductSerial.description /
    // ProductSerial.images instead (see ProductSerial.modal.js), since
    // condition/cosmetic notes genuinely differ unit-to-unit even for
    // the same model. These fields are kept on Product (not removed)
    // only because non-serialized products still need them, and because
    // pre-existing serialized products may already have legacy data
    // here - never trust these as per-unit data going forward, and
    // never silently fall back to them for a serialized unit's display.
    description: {
      type: String,
      trim: true,
      default: "",
    },

    images: [
      {
        type: String,
        trim: true,
      },
    ],

    // S3 object keys behind each images[] URL, same index alignment as
    // images[] - needed to delete/replace individual S3 objects without
    // parsing keys back out of public URLs (same pattern as
    // Branch.logoKey / User.profilePhotoKey).
    imageKeys: [
      {
        type: String,
        trim: true,
      },
    ],

    // =========================
    // PRODUCT TYPE
    // =========================
    // Server-derived from `category` (see utils/deriveProductType.js) -
    // never accepted from the client. ACCESSORY -> false, MOBILE/LAPTOP/
    // TAB -> true.
    isSerialized: {
      type: Boolean,
      default: false,
    },

    // =========================
    // NON-SERIALIZED PRODUCT
    // =========================
    productCode: {
      type: String,
      uppercase: true,
      trim: true,
      // Note: no field-level `sparse`/`index` here - the actual index
      // (unique + partial, so soft-deleted products don't block code
      // reuse) is declared once, explicitly, below via
      // productSchema.index(). A field-level `sparse: true` here would
      // register a second, conflicting index declaration on the same
      // key (this previously caused a "duplicate schema index" warning
      // on every server start, and the live DB index actually built
      // from it had neither `sparse` nor the partial filter).

      validate: {
        validator: function (value) {
          // Required only for non-serialized products
          if (!this.isSerialized) {
            return !!value && value.trim().length > 0;
          }

          // For serialized products, don't save null/undefined
          // The field will be omitted from the document
          return true;
        },
        message: "Product Code is required for non-serialized products",
      },

      // Ensure serialized products don't store null in the database
      // This prevents unique index conflicts
      set: function (value) {
        if (this?.isSerialized) {
          return undefined; // Remove the field entirely for serialized products
        }
        return value;
      },
    },

    hsnCode: {
      type: String,
      trim: true,
      default: "",

      // Common to both serialized and non-serialized products - always
      // required, not conditional on isSerialized.
      validate: {
        validator: function (value) {
          return !!value && value.trim().length > 0;
        },
        message: "HSN/SAC Code is required",
      },
    },

    // =========================
    // SERIALIZED PRODUCT
    // =========================
    // One serialized product = one Model Number (never an array - each
    // physical unit's own model detail, if it ever needs to differ, lives
    // per-unit on ProductSerial.modelNumber, not here). Not used at all
    // for non-serialized products.
    modelNumber: {
      type: String,
      trim: true,

      set: function (value) {
        return typeof value === "string" ? value.trim().toUpperCase() : value;
      },

      validate: {
        validator: function (value) {
          // Required only for serialized products
          if (this.isSerialized) {
            return !!value && value.trim().length > 0;
          }

          // Not required for non-serialized products
          return true;
        },
        message: "Model Number is required for serialized products",
      },
    },

    // =========================
    // STATUS FLAGS
    // =========================
    isActive: {
      type: Boolean,
      default: true,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },

    deletedAt: {
      type: Date,
      default: null,
    },

    // =========================
    // AUDIT FIELDS
    // =========================
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    createdByRole: {
      type: String,
      enum: ["SUPER_ADMIN", "BRANCH_ADMIN"],
      required: true,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedByRole: {
      type: String,
      enum: ["SUPER_ADMIN", "BRANCH_ADMIN"],
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// ============================================================
// UNIQUE PRODUCT CODE
// ONLY NON-SERIALIZED PRODUCTS USE PRODUCT CODE
//
// Partial (not just sparse) so the uniqueness constraint only applies
// among non-deleted products - a soft-deleted product's old code must
// not permanently block that code from being reused by a new product.
// ============================================================

productSchema.index(
  { productCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      productCode: { $exists: true, $type: "string" },
    },
  },
);

const Product = mongoose.model("Product", productSchema);

export default Product;

