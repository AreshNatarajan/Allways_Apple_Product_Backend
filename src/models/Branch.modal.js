import mongoose from "mongoose";

const branchSchema = new mongoose.Schema(
  {
    // =========================
    // BASIC BRANCH INFORMATION
    // =========================
    name: {
      type: String,
      required: true,
      trim: true,
    },

    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },

    // =========================
    // BRANCH LOGO
    // =========================
    logo: {
      type: String,
      default: null,
      trim: true,
    },

    // S3 object key behind logo's URL (needed to safely delete/replace
    // the image without parsing it back out of the URL)
    logoKey: {
      type: String,
      default: null,
      trim: true,
    },

    // =========================
    // CONTACT INFORMATION
    // =========================
    email: {
      type: String,
      default: "",
      lowercase: true,
      trim: true,
    },

    // One branch can have multiple phone numbers
    phones: {
      type: [String],
      default: [],
    },

    // =========================
    // BANKING DETAILS
    // =========================
    bankDetails: {
      accountHolderName: { type: String, default: "", trim: true },
      bankName: { type: String, default: "", trim: true },
      accountNumber: { type: String, default: "", trim: true },
      ifscCode: { type: String, default: "", trim: true, uppercase: true },
      bankBranch: { type: String, default: "", trim: true },
    },

    // =========================
    // UPI
    // =========================
    upiQrImage: {
      type: String,
      default: null,
      trim: true,
    },

    // S3 object key behind upiQrImage's URL (same pattern as logoKey)
    upiQrImageKey: {
      type: String,
      default: null,
      trim: true,
    },

    // =========================
    // BRANCH ADDRESS
    // =========================
    address: {
      addressLine1: {
        type: String,
        default: "",
        trim: true,
      },

      addressLine2: {
        type: String,
        default: "",
        trim: true,
      },

      city: {
        type: String,
        default: "",
        trim: true,
      },

      state: {
        type: String,
        default: "",
        trim: true,
      },

      country: {
        type: String,
        default: "India",
        trim: true,
      },

      pincode: {
        type: String,
        default: "",
        trim: true,
      },
    },

    // =========================
    // LOCATION
    // =========================
    googleMapUrl: {
      type: String,
      default: "",
      trim: true,
    },

    // =========================
    // STATUS
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

const Branch = mongoose.model("Branch", branchSchema);

export default Branch;


