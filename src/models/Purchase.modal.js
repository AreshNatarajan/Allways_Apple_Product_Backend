import mongoose from "mongoose";

// Payment Details Schema
const paymentDetailSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    paymentDate: {
      type: Date,
      default: Date.now,
    },
    paymentMethod: {
      type: String,
      enum: ["CASH", "UPI", "CARD", "NET_BANKING", "CHEQUE", "EMI"],
      default: "CASH",
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },
    attachment: {
      type: String,
      default: null,
    },
    // Who actually handled this specific payment - full audit trail
    // for multi-user cash handling. Optional/unset on payments
    // recorded before this field existed, and on payments recorded
    // until the corresponding controller work populates it from
    // req.user - kept non-required here so today's existing
    // payment-recording flow (which doesn't set this yet) isn't
    // broken by this schema-only change. Never affects freeze logic -
    // paymentDetails stays outside PURCHASE_FROZEN_FIELDS regardless.
    handledBy: {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      name: {
        type: String,
        default: "",
      },
      role: {
        type: String,
        default: "",
      },
    },
  },
  { _id: false }
);

// Purchase Item Schema - Updated to support both serialized and non-serialized
const purchaseItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    // For serialized products
    serialNumbers: [
      {
        serialNumber: {
          type: String,
          required: true,
          trim: true,
        },
      },
    ],
    // For non-serialized products - batch info
    batches: [
      {
        batchNumber: {
          type: String,
          trim: true,
        },
        quantity: {
          type: Number,
          required: true,
          min: 1,
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
        batchId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Batch",
          default: null,
        },
      },
    ],
    // Common fields for both types
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
    totalPrice: {
      type: Number,
      required: true,
    },
    // Serialized only
    gstApplicable: {
      type: Boolean,
      default: false,
    },
    // Non-serialized only
    hsnCode: {
      type: String,
      default: "",
      trim: true,
    },
    purchaseGstPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    purchaseGstAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Destination branch for this item (for SUPER_ADMIN purchases)
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
  },
  {
    _id: false,
  }
);

const purchaseSchema = new mongoose.Schema(
  {
    purchaseNumber: {
      type: String,
      unique: true,
      required: true,
      uppercase: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: true,
    },
    // Vendor details exactly as they were at the moment of purchase -
    // protects historical invoices from later Vendor edits (name/GST/
    // address changes must never rewrite what an old purchase says).
    // Optional/unset on documents created before this field existed.
    vendorSnapshot: {
      name: { type: String, default: "" },
      gstNumber: { type: String, default: "" },
      phone: { type: String, default: "" },
      email: { type: String, default: "" },
      address: { type: String, default: "" },
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
    // CENTRAL = SUPER_ADMIN purchase, assigned to branch(es) via
    // PendingReceive. BRANCH = BRANCH_ADMIN direct purchase, entering
    // that branch's stock immediately. Optional/unset on documents
    // created before this field existed.
    poType: {
      type: String,
      enum: ["CENTRAL", "BRANCH"],
      default: null,
    },
    reference: {
      type: String,
      default: "",
      trim: true,
    },
    systemInvoiceFile: {
      type: String,
      default: null,
    },
    purchaseDate: {
      type: Date,
      default: Date.now,
    },
    paymentStatus: {
      type: String,
      enum: ["PAID", "PENDING", "PARTIAL"],
      default: "PAID",
    },
    paidAmount: {
      type: Number,
      default: 0,
    },
    pendingAmount: {
      type: Number,
      default: 0,
    },
    paymentDetails: {
      type: [paymentDetailSchema],
      default: [],
    },
    invoiceFile: {
      type: String,
      default: null,
    },
    signatureFile: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ["DRAFT", "COMPLETED", "CANCELLED"],
      default: "COMPLETED",
    },
    // Rolled-up receiving progress across EVERY destination branch this
    // purchase assigned stock to (a CENTRAL purchase can span several
    // branches) - recomputed after every branch's receive event from
    // the real per-branch PendingReceive/ProductSerial state, never
    // hand-set. Stays PENDING for a BRANCH (direct-receive) purchase,
    // which has nothing to receive later.
    overallReceiveStatus: {
      type: String,
      enum: ["PENDING", "PARTIAL", "COMPLETED"],
      default: "PENDING",
    },
    items: [purchaseItemSchema],
    totalAmount: {
      type: Number,
      required: true,
    },
    // Whether the total was rounded to the nearest whole rupee - a
    // genuine on/off toggle in the create-purchase UI, not a monetary
    // value itself. totalAmount above already reflects the rounded
    // figure when this is true.
    roundOff: {
      type: Boolean,
      default: false,
    },
    // The computed rounding delta (finalAmount - totalBeforeRoundOff),
    // persisted purely for audit visibility - previously calculated
    // client-side and discarded. Zero when roundOff is false.
    roundOffAmount: {
      type: Number,
      default: 0,
    },
    notes: {
      type: String,
      default: "",
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
    // ============================================================
    // EOD REVIEW (mirrors Sale.modal.js exactly)
    // ============================================================
    // Only ever set to PENDING_REVIEW by updatePurchase.controller.js
    // when a non-SUPER_ADMIN edits this purchase (never at create time -
    // unlike Sale, a freshly created purchase needs no review). A
    // SUPER_ADMIN's own edit clears it back to null instead, since
    // SUPER_ADMIN is already the reviewing authority. Once reviewed,
    // editing again resets it back to PENDING_REVIEW - review always
    // reflects the latest edited state, never a stale one.
    processStatus: {
      type: String,
      enum: ["PENDING_REVIEW", "APPROVED", "REJECTED"],
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// purchaseNumber already has unique: true (field-level).
//
// Compound indexes below all lead with isDeleted since every list query
// filters on it first - added for the Get All Purchases enhancement,
// which now actually filters/sorts on each of these fields. None of
// these change query results, only performance.
purchaseSchema.index({ isDeleted: 1, purchaseDate: -1 });
purchaseSchema.index({ isDeleted: 1, branchId: 1 });
purchaseSchema.index({ isDeleted: 1, poType: 1 });
purchaseSchema.index({ isDeleted: 1, paymentStatus: 1 });
purchaseSchema.index({ isDeleted: 1, status: 1 });
purchaseSchema.index({ isDeleted: 1, vendorId: 1 });
// Supports the CENTRAL multi-branch item-level filter/attribution
// (a purchase's own branchId is null for CENTRAL - the destination
// branch lives per item instead).
purchaseSchema.index({ "items.branchId": 1 });
// Powers the EOD review queue/badge (mirrors Sale.modal.js's identical index).
purchaseSchema.index({ isDeleted: 1, processStatus: 1 });

// ============================================================
// FIELD-LEVEL HISTORICAL FREEZE
// ============================================================
// A purchase is editable while it's a DRAFT. Once it leaves DRAFT
// (COMPLETED or CANCELLED - anything other than DRAFT represents a
// finalized transaction, not a work-in-progress one), the fields that
// describe what/where/how much inventory was created must never be
// rewritten - that's what actually moved stock and can't be silently
// redirected after the fact. Everything else describing the
// transaction (who it was bought from, when, why) is a correctable
// data-entry detail, not an inventory fact, so it stays editable via
// the dedicated Purchase Edit flow (updatePurchase.controller.js) even
// once COMPLETED - see that controller for the real guardrails
// (vendor re-validation, EOD re-review on every edit).
//
// Frozen once no longer DRAFT: branchId/poType (where the inventory
// was created - CENTRAL vs BRANCH changes where PendingReceive/
// BatchStock already point - this can never change after the fact).
//
// items/totalAmount/roundOff/roundOffAmount are schema-mutable (an
// edit needs to be able to APPEND a missed item and grow the total),
// but NOT schema-frozen protection here means updatePurchase.controller.js
// itself is the enforcement point: it only ever appends new entries to
// items (via purchaseItemProcessor.service.js, the same
// inventory-creation code createPurchase.controller.js uses) and never
// mutates or removes an existing entry - every already-existing
// physical unit/batch this purchase already created stays exactly as
// it was. totalAmount only ever grows by exactly the sum of the
// appended items.
//
// Stays mutable always: vendorId/vendorSnapshot, purchaseDate,
// reference, paymentStatus, paidAmount, pendingAmount, paymentDetails,
// status itself, notes, invoice/signature file attachments, updatedBy,
// isDeleted/deletedAt (soft-delete stays possible per this project's
// soft-delete-only convention), processStatus/reviewedBy/reviewedAt.
const PURCHASE_FROZEN_FIELDS = [
  "branchId",
  "poType",
];

// Captures the persisted status at load time, before any in-memory
// modification - post('init') fires only when a document is hydrated
// from the database (not on `new Purchase()`/.create()), so this
// never runs for a genuinely new document.
purchaseSchema.post("init", function () {
  this.$locals.wasFrozen = this.status !== "DRAFT";
});

const purchaseFrozenFieldError = (fields) =>
  new Error(
    `Cannot modify ${fields.join(", ")} on a purchase that is no longer DRAFT - ` +
    `these fields are frozen once a purchase is finalized. Payment fields and status remain editable.`
  );

// GAP 2 fix: `isNew` reports true whenever a document was constructed
// via `new Purchase(...)` rather than fetched - but that alone isn't
// proof nothing with this _id already exists (e.g. an explicit _id
// collision). Before fast-pathing as "genuine creation", verify no
// already-finalized document shares this _id. For the real, common
// creation path this is a single fast indexed lookup that always
// returns null (a freshly auto-generated ObjectId has never existed
// before) - it does not block createPurchaseController's own
// legitimate multi-save finalization sequence (attaching batch info,
// then the generated invoice filename, across several saves on the
// SAME freshly-created in-memory document): those subsequent saves
// have isNew:false but were never hydrated via a query, so
// $locals.wasFrozen was never set by post('init') and the second
// branch below correctly lets them through.
// Promise-style middleware (async function, no `next` parameter) -
// mixing `async` with an explicit `next()` callback is invalid
// Mongoose/Kareem middleware style and throws "next is not a function"
// at runtime, confirmed by direct testing. Throwing rejects the save;
// returning normally resolves it.
purchaseSchema.pre("save", async function () {
  if (this.isNew) {
    const existing = await this.constructor.findOne({ _id: this._id }).select("status").lean();
    if (existing && existing.status !== "DRAFT") {
      const modifiedFrozenFields = PURCHASE_FROZEN_FIELDS.filter((field) => this.isModified(field));
      if (modifiedFrozenFields.length > 0) {
        throw purchaseFrozenFieldError(modifiedFrozenFields);
      }
    }
    return;
  }

  if (!this.$locals.wasFrozen) return;

  const modifiedFrozenFields = PURCHASE_FROZEN_FIELDS.filter((field) => this.isModified(field));
  if (modifiedFrozenFields.length > 0) {
    throw purchaseFrozenFieldError(modifiedFrozenFields);
  }
});

// ============================================================
// GAP 1 FIX: QUERY-LEVEL FREEZE PROTECTION
// ============================================================
// updateOne/updateMany/findOneAndUpdate/findByIdAndUpdate never
// construct a Document and never trigger pre('save') - a controller
// using any of these completely bypasses the guard above (confirmed
// live in bulkReceiveController's Purchase.findByIdAndUpdate call).
// This hook inspects the update payload for frozen-field paths
// (covering $set, $push, $inc, direct assignment, etc.) and, only if
// one is touched, looks up the target document(s)' current status
// before deciding. Payment-only updates never trigger the status
// lookup at all - always allowed regardless of the purchase's status.
async function guardPurchaseQueryUpdate() {
  const update = this.getUpdate() || {};
  const touchedPaths = new Set();

  for (const key of Object.keys(update)) {
    if (key.startsWith("$")) {
      for (const path of Object.keys(update[key] || {})) {
        touchedPaths.add(path.split(".")[0]);
      }
    } else {
      touchedPaths.add(key.split(".")[0]);
    }
  }

  const touchedFrozen = PURCHASE_FROZEN_FIELDS.filter((f) => touchedPaths.has(f));
  if (touchedFrozen.length === 0) return;

  // updateMany could match several documents at once - block the
  // whole operation if even one matched document is already
  // finalized, rather than only checking the first match.
  const nonDraftMatchCount = await this.model.countDocuments({
    ...this.getQuery(),
    status: { $ne: "DRAFT" },
  });

  if (nonDraftMatchCount > 0) {
    throw new Error(
      `Cannot modify ${touchedFrozen.join(", ")} via a query-level update - this would affect ` +
      `at least one purchase that is no longer DRAFT, where these fields are frozen.`
    );
  }
}

purchaseSchema.pre("updateOne", { document: false, query: true }, guardPurchaseQueryUpdate);
purchaseSchema.pre("updateMany", guardPurchaseQueryUpdate);
purchaseSchema.pre("findOneAndUpdate", guardPurchaseQueryUpdate);

// ============================================================
// GAP 3 FIX: HARD-DELETE PROTECTION
// ============================================================
// This project is soft-delete-only everywhere (isDeleted/deletedAt) -
// a hard delete of a financial record should never be reachable at
// all, regardless of status. Unlike the update guard above, this is a
// blanket block: there is no legitimate hard-delete workflow at any
// stage of a Purchase's lifecycle.
const PURCHASE_HARD_DELETE_ERROR = new Error(
  "Purchase records cannot be hard-deleted - use the soft-delete (isDeleted/deletedAt) workflow instead."
);

purchaseSchema.pre("deleteOne", { document: false, query: true }, function () {
  throw PURCHASE_HARD_DELETE_ERROR;
});
purchaseSchema.pre("deleteMany", function () {
  throw PURCHASE_HARD_DELETE_ERROR;
});
purchaseSchema.pre("findOneAndDelete", function () {
  throw PURCHASE_HARD_DELETE_ERROR;
});
purchaseSchema.pre("deleteOne", { document: true, query: false }, function () {
  throw PURCHASE_HARD_DELETE_ERROR;
});

const Purchase = mongoose.model("Purchase", purchaseSchema);

export default Purchase;



