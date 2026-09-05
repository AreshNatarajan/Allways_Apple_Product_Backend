import mongoose from "mongoose";

// A curated, staff-managed public-catalog listing for one Product -
// deliberately a SEPARATE model from Product/BatchStock/ProductSerial,
// never touching any of them.
//
// NOT CURRENTLY WIRED TO THE PUBLIC STOREFRONT - the public read
// endpoints (routes/storefront/publicStorefront.router.js) were
// switched to read live from ProductSerial (real branch inventory)
// directly instead, per a later decision. This model, its staff CRUD
// endpoints (routes/storefront/storefront.router.js), and the "Online
// Catalog" admin page are left in place (not deleted - the curation
// workflow may still be wanted later), just no longer read by anything
// customer-facing.
const storefrontProductSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
      unique: true,
    },

    // The public on/off switch - only isListed:true rows are ever
    // returned by the public (unauthenticated) endpoints. A row can
    // exist (in-progress curation) without being visible yet.
    isListed: {
      type: Boolean,
      default: false,
    },

    // The curated online price - entered by staff, deliberately
    // independent of BatchStock.sellingPrice/ProductSerial.sellingPrice.
    displayPrice: {
      type: Number,
      required: true,
      min: 0,
    },

    // Public marketing copy - distinct from Product.description (which
    // is only ever a source of truth for non-serialized products
    // internally) and from any ProductSerial per-unit condition notes.
    shortDescription: {
      type: String,
      trim: true,
      default: "",
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },

    images: {
      type: [
        {
          url: { type: String, required: true },
          key: { type: String, required: true },
          _id: false,
        },
      ],
      default: [],
    },

    // Homepage/category ordering.
    featured: {
      type: Boolean,
      default: false,
    },
    sortOrder: {
      type: Number,
      default: 0,
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

storefrontProductSchema.index({ isDeleted: 1, isListed: 1, sortOrder: 1 });
storefrontProductSchema.index({ isDeleted: 1, featured: 1 });

const StorefrontProduct = mongoose.model("StorefrontProduct", storefrontProductSchema);

export default StorefrontProduct;
