// models/Service.modal.js
import mongoose from "mongoose";

// Service is NOT Transfer. A product can physically move Origin Branch
// -> Service Branch (Chennai) -> Service Vendor -> Service Branch ->
// Origin Branch -> Customer, but every one of those movements belongs
// to THIS record and to ServiceHistory - no Transfer/TransferHistory
// document is ever created by any Service action. See
// updateServiceStatus.controller.js.
//
// Status lifecycle (10 steps). The spec's own lifecycle diagram names
// the first and last step identically ("CUSTOMER_RECEIVED" - once
// meaning "we received the product from the customer", once meaning
// "the customer received it back"). Reusing one enum value for both
// would make the state machine ambiguous - "just created" and "fully
// done" would be indistinguishable from `status` alone. Resolved by
// keeping CUSTOMER_RECEIVED as the intake status only, and using a
// distinct terminal value, SERVICE_COMPLETED, for completion - the UI
// action that reaches it is still labelled "Customer Received" (see
// ServiceDetailPage's ACTION_CONFIG), matching the spec's own action
// table. SERVICE_COMPLETED only applies to NEW_CUSTOMER/OUT_CUSTOMER -
// an INVENTORY-type service has no customer at the end and terminates
// at ORIGINAL_BRANCH_RECEIVED instead (see updateServiceStatus).
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

// One row per physical item on the service ticket - a ticket can carry
// several products/units at once (mirrors Transfer.modal.js's
// items[] pattern). Every row belongs to the SAME serviceType as the
// parent ticket (a ticket is either entirely customer-owned or
// entirely our own inventory, never mixed), but acquisition is tracked
// per row since two INVENTORY rows on one ticket can legitimately come
// from different sources (existing stock vs. a fresh direct-purchase).
const serviceItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true },

    // INVENTORY rows only - the real physical unit being held. Never
    // set for a customer-owned row - see serialNumberText below.
    productSerialId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductSerial", default: null },

    // Customer-owned rows only (NEW_CUSTOMER/OUT_CUSTOMER) - free-text
    // serial for a unit with no ProductSerial record of its own. Never
    // used to fabricate a Purchase/serial record - see spec section 15.
    serialNumberText: { type: String, default: "", trim: true },
    // Condition/cosmetic note for a customer-owned unit, same {main,
    // second} shape as ProductSerial.description for consistency. Not
    // used for INVENTORY rows - that unit's own ProductSerial.description
    // already carries this.
    description: {
      main: { type: String, default: "", trim: true },
      second: { type: String, default: "", trim: true },
    },
    // Customer-owned rows only - real S3 objects already uploaded via
    // the staging-image endpoints by the time the ticket is submitted
    // (same pattern as ProductSerial.images / Purchase Entry).
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

    issueDescription: { type: String, default: "", trim: true },

    // Per-row acquisition tracking - makes the Chennai-direct-purchase
    // case (spec section 5/16) explicit and queryable per unit, since
    // two INVENTORY rows on the same ticket can come from different
    // sources. CUSTOMER_INTAKE for every row on a NEW_CUSTOMER/
    // OUT_CUSTOMER ticket.
    acquisitionSource: {
      type: String,
      enum: ["CUSTOMER_INTAKE", "EXISTING_INVENTORY", "DIRECT_SERVICE_PURCHASE"],
      required: true,
    },
    // Set only when acquisitionSource is DIRECT_SERVICE_PURCHASE -
    // links to the ordinary, unmodified Purchase made specifically to
    // obtain this unit for service. Never used to alter or annotate
    // the Purchase document itself.
    acquisitionPurchaseId: { type: mongoose.Schema.Types.ObjectId, ref: "Purchase", default: null },
  },
  { _id: false }
);

const serviceSchema = new mongoose.Schema(
  {
    serviceNumber: {
      type: String,
      unique: true,
    },

    // NEW_CUSTOMER - customer has no existing Customer record, one is
    // created inline. OUT_CUSTOMER - an existing Customer record is
    // picked. INVENTORY - our own branch stock (real ProductSerial
    // units), no customer at all. Fixed for the whole ticket - every
    // item[] row shares it, never mixed on one ticket.
    serviceType: {
      type: String,
      enum: ["NEW_CUSTOMER", "OUT_CUSTOMER", "INVENTORY"],
      required: true,
    },

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    // Customer details exactly as they were at intake - same pattern
    // as Sale.customerSnapshot - so a later Customer edit never
    // rewrites a historical service ticket.
    customerSnapshot: {
      name: { type: String, default: "" },
      mobile: { type: String, default: "" },
      email: { type: String, default: "" },
    },

    // One or more physical items on this ticket - see serviceItemSchema
    // above. Always at least one (enforced in createService.controller.js).
    items: {
      type: [serviceItemSchema],
      default: [],
    },

    // Preserved permanently - the branch the product must eventually
    // return to, regardless of how many stops it makes in between.
    originBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    originBranchName: {
      type: String,
      required: true,
    },
    serviceBranchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    serviceBranchName: {
      type: String,
      required: true,
    },

    serviceVendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceVendor",
      default: null,
    },

    status: {
      type: String,
      enum: SERVICE_STATUSES,
      default: "CUSTOMER_RECEIVED",
    },

    // Set at the VENDOR_RETURN transition (see updateServiceStatus.controller.js) -
    // captures whether the Service Vendor could actually repair the
    // item(s) or not. REPAIRED proceeds through FINISHED as normal;
    // UNABLE_TO_REPAIR requires a reason (repairOutcomeNotes) but still
    // proceeds through the same remaining steps (FINISHED ->
    // SEND_TO_ORIGINAL_BRANCH -> ...) to return the item(s) as-is - no
    // separate/shortened status path, just a recorded outcome + reason.
    repairOutcome: {
      type: String,
      enum: ["REPAIRED", "UNABLE_TO_REPAIR", null],
      default: null,
    },
    repairOutcomeNotes: {
      type: String,
      default: "",
      trim: true,
    },

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    // ============================================================
    // PER-STAGE CONVENIENCE FIELDS - mirrors Transfer.modal.js's
    // packedBy/At, dispatchedBy/At style. ServiceHistory stays the
    // source of truth; these just make "who/when for the current
    // state" cheap to render without a second query.
    // ============================================================
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, required: true },

    sentToServiceBranchBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    sentToServiceBranchByName: { type: String, default: null },
    sentToServiceBranchAt: { type: Date, default: null },

    serviceBranchReceivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    serviceBranchReceivedByName: { type: String, default: null },
    serviceBranchReceivedAt: { type: Date, default: null },

    allocatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    allocatedByName: { type: String, default: null },
    allocatedAt: { type: Date, default: null },

    processingStartedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    processingStartedByName: { type: String, default: null },
    processingStartedAt: { type: Date, default: null },

    vendorReturnedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    vendorReturnedByName: { type: String, default: null },
    vendorReturnedAt: { type: Date, default: null },

    finishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    finishedByName: { type: String, default: null },
    finishedAt: { type: Date, default: null },

    sentToOriginalBranchBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    sentToOriginalBranchByName: { type: String, default: null },
    sentToOriginalBranchAt: { type: Date, default: null },

    originalBranchReceivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    originalBranchReceivedByName: { type: String, default: null },
    originalBranchReceivedAt: { type: Date, default: null },

    // "Customer Received" in the UI - see status enum comment above.
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    completedByName: { type: String, default: null },
    completedAt: { type: Date, default: null },

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

serviceSchema.virtual("totalItems").get(function () {
  return this.items?.length || 0;
});
serviceSchema.set("toJSON", { virtuals: true });
serviceSchema.set("toObject", { virtuals: true });

serviceSchema.index({ originBranchId: 1, status: 1 });
serviceSchema.index({ serviceBranchId: 1, status: 1 });
serviceSchema.index({ serviceVendorId: 1 });
serviceSchema.index({ status: 1, createdAt: -1 });
serviceSchema.index({ serviceType: 1, createdAt: -1 });
serviceSchema.index({ isDeleted: 1 });

export const SERVICE_STATUS_VALUES = SERVICE_STATUSES;

const Service = mongoose.model("Service", serviceSchema);
export default Service;
