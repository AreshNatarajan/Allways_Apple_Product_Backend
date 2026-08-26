// models/Vendor.modal.js
import mongoose from "mongoose";

const vendorSchema = new mongoose.Schema(
  {
    // =========================
    // BASIC INFORMATION
    // =========================
    name: {
      type: String,
      required: true,
      trim: true,
    },

    companyName: {
      type: String,
      default: "",
      trim: true,
    },

    phone: {
      type: String,
      default: "",
      trim: true,
    },

    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    address: {
      type: String,
      default: "",
      trim: true,
    },

    // =========================
    // BUSINESS INFORMATION
    // =========================
    gstNumber: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
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
      // Pre-existing gap fixed in passing: Vendor creation has been
      // open to any authenticated role (incl. STAFF) at the route
      // level all along (see routes/vendor/vendor.router.js's own
      // comment), but this enum never actually allowed STAFF to be
      // saved - a STAFF-created vendor would 500 on this validation.
      enum: ["SUPER_ADMIN", "BRANCH_ADMIN", "STAFF"],
      required: true,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedByRole: {
      type: String,
      enum: ["SUPER_ADMIN", "BRANCH_ADMIN", "STAFF"],
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// ============================================================
// VENDOR IS GLOBAL - no branchId field or filter anywhere on
// this schema. The same vendor is shared across every branch.
//
// Unique indexes are partial (scoped to isDeleted:false) so a
// soft-deleted vendor's name/GST/code never permanently blocks
// reuse by a new vendor - same reasoning as Product.productCode.
// (Previously this was a field-level `unique:true` PLUS a
// duplicate explicit schema.index() call, which is what actually
// caused the "duplicate schema index" warning and left the real
// index non-partial - fixed here to a single declaration.)
// ============================================================

vendorSchema.index(
  { name: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
  }
);

vendorSchema.index(
  { gstNumber: 1 },
  {
    unique: true,
    // MongoDB partial-index expressions don't support $ne, so "not
    // empty string" is expressed as $gt: "" (every non-empty string
    // sorts after "") - this still correctly excludes the default ""
    // value every vendor without a GST number has.
    partialFilterExpression: {
      isDeleted: false,
      gstNumber: { $gt: "" },
    },
  }
);

vendorSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      email: { $gt: "" },
    },
  }
);

const Vendor = mongoose.model("Vendor", vendorSchema);

export default Vendor;
