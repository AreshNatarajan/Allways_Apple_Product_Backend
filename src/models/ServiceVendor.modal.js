// models/ServiceVendor.modal.js
import mongoose from "mongoose";

// Deliberately separate from Vendor.modal.js. Vendor is used only for
// purchasing stock from a supplier (Company -> Purchase Vendor); a
// Service Vendor is a repair/service center a product is sent to
// during the Service workflow (Chennai Service Branch -> Service
// Vendor -> Product serviced -> returned). Same business-entity shape
// as Vendor (name/phone/email/address/notes/isActive) by convention,
// but never the same collection/model - merging them would let a
// repair center show up in the Purchase flow's vendor picker and vice
// versa, which is exactly what this separation exists to prevent.
const serviceVendorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
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

    notes: {
      type: String,
      default: "",
      trim: true,
    },

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

// Global master (no branchId), same reasoning as Vendor - a repair
// center is shared across every branch that sends it work.
serviceVendorSchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);

serviceVendorSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, email: { $gt: "" } } }
);

const ServiceVendor = mongoose.model("ServiceVendor", serviceVendorSchema);

export default ServiceVendor;
