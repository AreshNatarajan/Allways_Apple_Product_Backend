// models/ServiceHistory.modal.js
import mongoose from "mongoose";

// Permanent, append-only Service-lifecycle audit trail - copies
// TransferHistory.modal.js's exact shape and enforcement. Every status
// transition (see updateServiceStatus.controller.js) writes exactly
// one of these, atomically alongside the Service document's own status
// write. Never updated or deleted once created - a correction is made
// by writing a new entry, never by editing a past one.
const SERVICE_STATUSES = [
  "CUSTOMER_RECEIVED",
  "SENT_TO_SERVICE_BRANCH",
  "SERVICE_BRANCH_RECEIVED",
  "VENDOR_ALLOCATED",
  "VENDOR_PROCESSING",
  "VENDOR_RETURNED",
  "FINISHED",
  "SENT_TO_ORIGINAL_BRANCH",
  "ORIGINAL_BRANCH_RECEIVED",
  "SERVICE_COMPLETED",
];

const serviceHistorySchema = new mongoose.Schema(
  {
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },
    serviceNumber: {
      type: String,
      required: true,
    },
    action: {
      type: String,
      enum: [
        "CREATED",
        "SENT_TO_SERVICE_BRANCH",
        "SERVICE_BRANCH_RECEIVED",
        "VENDOR_ALLOCATED",
        "VENDOR_PROCESSING_STARTED",
        "VENDOR_RETURNED",
        "FINISHED",
        "SENT_TO_ORIGINAL_BRANCH",
        "ORIGINAL_BRANCH_RECEIVED",
        "CUSTOMER_RECEIVED",
      ],
      required: true,
    },
    fromStatus: {
      type: String,
      enum: SERVICE_STATUSES,
      default: null,
    },
    toStatus: {
      type: String,
      enum: SERVICE_STATUSES,
      default: null,
    },
    // Branch where this action was physically performed.
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
    // Populated only on the VENDOR_ALLOCATED entry.
    serviceVendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceVendor",
      default: null,
    },
    notes: {
      type: String,
      default: "",
    },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    performedByName: {
      type: String,
      required: true,
    },
    performedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

serviceHistorySchema.index({ serviceId: 1, performedAt: 1 });
serviceHistorySchema.index({ serviceNumber: 1 });
serviceHistorySchema.index({ performedBy: 1, performedAt: -1 });
serviceHistorySchema.index({ action: 1, performedAt: -1 });

serviceHistorySchema.statics.logHistory = async function ({
  service,
  action,
  fromStatus,
  toStatus,
  branchId = null,
  serviceVendorId = null,
  notes = "",
  performedBy,
  performedByName,
  session,
}) {
  return this.create(
    [
      {
        serviceId: service._id,
        serviceNumber: service.serviceNumber,
        action,
        fromStatus,
        toStatus,
        branchId,
        serviceVendorId,
        notes,
        performedBy,
        performedByName,
      },
    ],
    { session }
  );
};

// ============================================================
// APPEND-ONLY ENFORCEMENT - identical pattern to TransferHistory.
// ============================================================
const SERVICE_HISTORY_UPDATE_ERROR = new Error(
  "ServiceHistory records are append-only and cannot be updated."
);
const SERVICE_HISTORY_DELETE_ERROR = new Error(
  "ServiceHistory records are append-only and cannot be deleted."
);

serviceHistorySchema.pre("updateOne", { document: false, query: true }, function () {
  throw SERVICE_HISTORY_UPDATE_ERROR;
});
serviceHistorySchema.pre("updateMany", function () {
  throw SERVICE_HISTORY_UPDATE_ERROR;
});
serviceHistorySchema.pre("findOneAndUpdate", function () {
  throw SERVICE_HISTORY_UPDATE_ERROR;
});

serviceHistorySchema.pre("deleteOne", { document: false, query: true }, function () {
  throw SERVICE_HISTORY_DELETE_ERROR;
});
serviceHistorySchema.pre("deleteMany", function () {
  throw SERVICE_HISTORY_DELETE_ERROR;
});
serviceHistorySchema.pre("findOneAndDelete", function () {
  throw SERVICE_HISTORY_DELETE_ERROR;
});
serviceHistorySchema.pre("deleteOne", { document: true, query: false }, function () {
  throw SERVICE_HISTORY_DELETE_ERROR;
});

serviceHistorySchema.pre("save", function () {
  if (!this.isNew) {
    throw SERVICE_HISTORY_UPDATE_ERROR;
  }
});

const ServiceHistory = mongoose.model("ServiceHistory", serviceHistorySchema);
export default ServiceHistory;
