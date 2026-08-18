import mongoose from "mongoose";

const customerSchema = new mongoose.Schema(
  {
    // Customer is BRANCH-SCOPED (unlike Vendor, which is a global
    // master) - every customer belongs to exactly one branch. Never
    // remove this or allow a "global" customer.
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
      index: true,
    },

    // =========================
    // BASIC INFORMATION
    // =========================
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // Kept as `mobile` (not renamed to `phone`) - Sale/Inventory/
    // Dashboard controllers already populate customerId with "name
    // mobile email"; renaming would silently break those read paths.
    mobile: {
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

    // =========================
    // ADDRESS
    // =========================
    address: {
      type: String,
      default: "",
      trim: true,
    },

    // =========================
    // BUSINESS INFORMATION
    // =========================
    // GST is OPTIONAL - never required, format validated only when
    // provided (enforced in the controllers, not here).
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

/**
 * 🔥 UNIQUE INDEX (ERP SAFE)
 * - Mobile unique per branch
 * - Ignores deleted records
 */
customerSchema.index(
  { branchId: 1, mobile: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      mobile: { $ne: "" },
    },
  }
);

/**
 * Optional: Email unique per branch
 */
customerSchema.index(
  { branchId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      email: { $ne: "" },
    },
  }
);

/**
 * GST is optional, but when provided must be unique per branch
 * (mirrors the mobile/email pattern above). Partial indexes can't use
 * $ne, so "not empty string" is expressed as $gt: "" - every non-empty
 * string sorts after "", so this still correctly excludes customers
 * with no GST.
 */
customerSchema.index(
  { branchId: 1, gstNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      isDeleted: false,
      gstNumber: { $gt: "" },
    },
  }
);

const Customer = mongoose.model("Customer", customerSchema);

export default Customer;






