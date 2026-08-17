import mongoose from "mongoose";

// ============================================================
// PAYMENT DETAILS
// ============================================================

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
    // recorded before this field existed, and until the corresponding
    // controller work populates it from req.user - kept non-required
    // here so today's existing payment-recording flow (which doesn't
    // set this yet) isn't broken by this schema-only change. Never
    // affects freeze logic - paymentDetails stays outside
    // SALE_FROZEN_FIELDS regardless.
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
  { _id: false },
);

// ============================================================
// SALE ITEM
// ============================================================

const saleItemSchema = new mongoose.Schema(
  {
    // ----------------------------------------------------------
    // PRODUCT
    // ----------------------------------------------------------

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },

    productCode: {
      type: String,
      default: "",
      trim: true,
    },

    modelNumber: {
      type: String,
      default: "",
      trim: true,
    },

    productName: {
      type: String,
      default: "",
      trim: true,
    },

    isSerialized: {
      type: Boolean,
      required: true,
    },

    // ----------------------------------------------------------
    // SERIALIZED PRODUCT
    // ----------------------------------------------------------

    productSerialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductSerial",
      default: null,
    },

    serialNumber: {
      type: String,
      default: "",
      trim: true,
    },

    // ----------------------------------------------------------
    // NON-SERIALIZED PRODUCT / BATCH
    // ----------------------------------------------------------

    // A non-serialized sale line always represents exactly one batch
    // (matches the barcode-scan-driven flow - scanning AAP20WCH-B001
    // identifies one specific batch; a second batch becomes a second
    // line, never merged into this one). These flat fields are what
    // new sales populate going forward.
    batchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Batch",
      default: null,
    },

    batchNumber: {
      type: String,
      default: "",
      trim: true,
    },

    barcode: {
      type: String,
      default: "",
      trim: true,
    },

    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Purchase",
      default: null,
    },

    purchaseNumber: {
      type: String,
      default: "",
      trim: true,
    },

    // DEPRECATED - kept only so historical Sale documents created
    // before the one-batch-per-line change remain fully readable
    // through this model without a data migration. Never populated by
    // new sales; do not remove without a schema-version-aware read
    // path, since old financial records must never be rewritten to
    // fit a newer shape.
    batches: [
      {
        batchId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Batch",
          required: true,
        },

        batchNumber: {
          type: String,
          required: true,
          trim: true,
        },

        barcode: {
          type: String,
          required: true,
          trim: true,
        },

        purchaseId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Purchase",
          default: null,
        },

        purchaseNumber: {
          type: String,
          default: "",
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

        profit: {
          type: Number,
          default: 0,
          min: 0,
        },
      },
      { _id: false },
    ],

    // ----------------------------------------------------------
    // QUANTITY
    // ----------------------------------------------------------

    quantity: {
      type: Number,
      default: 1,
      min: 1,
    },

    // ----------------------------------------------------------
    // PRICE
    // ----------------------------------------------------------

    purchasePrice: {
      type: Number,
      default: 0,
      min: 0,
    },

    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
    },

    // ----------------------------------------------------------
    // DISCOUNT
    // ----------------------------------------------------------

    discount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ----------------------------------------------------------
    // GST
    // ----------------------------------------------------------

    gstApplicable: {
      type: Boolean,
      default: false,
    },

    gstPercent: {
      type: Number,
      default: 0,
      min: 0,
    },

    gstAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Real input GST credit (ITC) for THIS line, frozen at sale time -
    // non-serialized only, mirroring Purchase.items/BatchStock's own
    // purchaseGstPercent (the batch's genuine purchase-time rate).
    // Always 0 for a serialized line: second-hand purchases never carry
    // an input GST value under the margin scheme (see
    // ProductSerial.modal.js/createPurchase.controller.js). Distinct
    // from gstPercent/gstAmount above, which are the OUTPUT rate/amount
    // charged to the customer at sale time - this pair is never added
    // to what the customer pays, it only offsets what's owed to the
    // government (see getProfitLoss.controller.js's GST-payable math).
    purchaseGstPercent: {
      type: Number,
      default: 0,
      min: 0,
    },

    purchaseGstAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    hsnCode: {
      type: String,
      default: "",
      trim: true,
    },

    // ----------------------------------------------------------
    // AMOUNTS
    // ----------------------------------------------------------

    subtotal: {
      type: Number,
      default: 0,
      min: 0,
    },

    finalAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // ----------------------------------------------------------
    // PROFIT
    // ----------------------------------------------------------
    // Deliberately NOT min:0 - a genuine loss sale (clearance, damaged
    // stock, a bad buy) computes a negative profit in
    // createSale.controller.js and must still be allowed to save. A
    // min:0 constraint here would throw a ValidationError on any loss
    // sale and silently block it from being recorded at all.

    profit: {
      type: Number,
      default: 0,
    },

    profitAfterGst: {
      type: Number,
      default: 0,
    },
  },
  { _id: false },
);

// ============================================================
// SALE
// ============================================================

const salesSchema = new mongoose.Schema(
  {
    saleNumber: {
      type: String,
      unique: true,
      required: true,
      trim: true,
    },

    // ----------------------------------------------------------
    // BRANCH
    // ----------------------------------------------------------

    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },

    // ----------------------------------------------------------
    // CUSTOMER
    // ----------------------------------------------------------

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },

    // Customer details exactly as they were at the moment of sale -
    // protects historical invoices from later Customer edits.
    // Optional/unset on documents created before this field existed.
    customerSnapshot: {
      name: { type: String, default: "" },
      mobile: { type: String, default: "" },
      email: { type: String, default: "" },
      gstNumber: { type: String, default: "" },
    },

    // ----------------------------------------------------------
    // DATE
    // ----------------------------------------------------------

    saleDate: {
      type: Date,
      default: Date.now,
    },

    // ----------------------------------------------------------
    // ITEMS
    // ----------------------------------------------------------

    items: {
      type: [saleItemSchema],
      required: true,
      validate: {
        validator: function (items) {
          return items.length > 0;
        },
        message: "Sale must contain at least one item",
      },
    },

    // ----------------------------------------------------------
    // TOTALS
    // ----------------------------------------------------------

    subtotalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalDiscount: {
      type: Number,
      default: 0,
      min: 0,
    },

    totalGstAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Sum of every non-serialized line's real input GST/ITC (see
    // saleItemSchema.purchaseGstAmount) - always 0 for a sale made up
    // entirely of serialized units. Lets reports (getProfitLoss's trend
    // bucketing in particular) compute a period's true net GST payable
    // without re-querying item-level detail.
    totalPurchaseGstAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Deliberately NOT min:0 - see the matching comment on
    // saleItemSchema.profit above. A sale can legitimately net to an
    // overall loss (e.g. every line sold at/below cost).
    totalProfit: {
      type: Number,
      default: 0,
    },

    totalProfitAfterGst: {
      type: Number,
      default: 0,
    },

    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // ----------------------------------------------------------
    // PAYMENT
    // ----------------------------------------------------------

    paymentDetails: {
      type: [paymentDetailSchema],
      default: [],
    },

    // PAID / PARTIAL / UNPAID (never "PENDING" - "pending" is
    // ambiguous with pendingAmount, which is also >0 for PARTIAL).
    // UNPAID = paidAmount 0 and pendingAmount === totalAmount.
    paymentStatus: {
      type: String,
      enum: ["PAID", "PARTIAL", "UNPAID"],
      default: "UNPAID",
    },

    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    pendingAmount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ----------------------------------------------------------
    // ACCOUNTABILITY: HANDLED-BY / SELFIE / EOD APPROVAL
    // ----------------------------------------------------------
    // Sale-level "who physically handled this at the counter" -
    // distinct from paymentDetailSchema.handledBy above (a per-payment
    // audit entry). Sale has no CENTRAL/BRANCH poType split like
    // Purchase - every sale ties to req.user.branchId regardless of
    // role, so the mandatory-vs-optional line is drawn purely on role
    // in createSale.controller.js (mandatory when the creator isn't
    // SUPER_ADMIN, optional/unset for SUPER_ADMIN). Never trusted as
    // raw name/role from the client - resolved server-side from a
    // submitted userId, same pattern as customerSnapshot.
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
    // Camera-only proof-of-presence photo, mandatory whenever handledBy
    // is mandatory, unset for a SUPER_ADMIN-created sale. Uploaded to
    // S3 before this document exists (see uploadSaleSelfie.controller.js).
    selfie: {
      key: { type: String, default: "" },
      url: { type: String, default: "" },
      uploadedAt: { type: Date, default: null },
    },
    // EOD (End of Day) audit-only review status - SUPER_ADMIN reviews
    // a non-SUPER_ADMIN-created sale after the fact for fraud/
    // accountability verification, from the sale's own detail page
    // (see reviewSale.controller.js). Deliberately NEVER touches stock,
    // payment, invoice, or GST - those are already final by sale time.
    // Stays null for a SUPER_ADMIN-created sale, which is out of EOD
    // review's scope entirely (a trusted, direct entry).
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

    // ----------------------------------------------------------
    // SIGNATURE
    // ----------------------------------------------------------

    signatureFile: {
      type: String,
      default: null,
    },

    // ----------------------------------------------------------
    // SYSTEM INVOICE (auto-generated PDF, mirrors Purchase's
    // systemInvoiceFile - a sale is never re-invoiced, only ever
    // invoiced once; see generateSaleInvoicePdf.js for the guard)
    // ----------------------------------------------------------

    systemInvoiceFile: {
      type: String,
      default: null,
    },

    // ----------------------------------------------------------
    // STATUS
    // ----------------------------------------------------------

    status: {
      type: String,
      enum: ["DRAFT", "COMPLETED", "CANCELLED"],
      default: "COMPLETED",
    },

    // ----------------------------------------------------------
    // NOTES
    // ----------------------------------------------------------

    notes: {
      type: String,
      default: "",
      trim: true,
    },

    // ----------------------------------------------------------
    // AUDIT
    // ----------------------------------------------------------

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    // ----------------------------------------------------------
    // FLAGS
    // ----------------------------------------------------------

    isCancelled: {
      type: Boolean,
      default: false,
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
  },
  {
    timestamps: true,
  },
);

// ============================================================
// INDEXES
// ============================================================

// saleNumber already has unique: true (field-level) - no redundant
// explicit index() call for it (matches Purchase.modal.js's convention,
// which also relies solely on the field-level unique index).
// Every list/stats query filters on isDeleted first (see
// getAllSalesController), so every compound index leads with it -
// matches the convention already proven on Purchase.modal.js.
salesSchema.index({ isDeleted: 1, saleDate: -1 });
salesSchema.index({ isDeleted: 1, branchId: 1 });
salesSchema.index({ isDeleted: 1, customerId: 1 });
salesSchema.index({ isDeleted: 1, paymentStatus: 1 });
salesSchema.index({ isDeleted: 1, status: 1 });
// Supports the EOD review filter on a sale's own detail page.
salesSchema.index({ isDeleted: 1, processStatus: 1 });
// Supports getProfitLoss.controller.js's actual query shape - every
// aggregation there filters on all four of these together
// (isDeleted/status/branchId/saleDate-range), several times per
// request. None of the single-field indexes above cover this compound
// filter, so this is added specifically for that report's performance.
salesSchema.index({ isDeleted: 1, status: 1, branchId: 1, saleDate: -1 });

// ============================================================
// FIELD-LEVEL HISTORICAL FREEZE
// ============================================================
// A sale is editable while it's a DRAFT. Once it leaves DRAFT
// (COMPLETED or CANCELLED - anything other than DRAFT represents a
// finalized transaction, not a work-in-progress one), the fields that
// describe what was actually sold/to-whom/for-how-much must never be
// rewritten - that's the historical record/invoice. Payment
// collection and status transitions (e.g. cancelling) are real,
// legitimate workflows that continue after completion, so those stay
// mutable.
//
// Frozen once no longer DRAFT: items (including the legacy batches[]
// shape on old documents - it's covered by the "items" entry below,
// since the whole items array is one modified path), totals, GST
// totals, customer identity/snapshot, branch, and sale date.
// Stays mutable always: paymentStatus, paidAmount, pendingAmount,
// paymentDetails, status itself, notes, signatureFile, isCancelled/
// isActive, updatedBy, isDeleted/deletedAt (soft-delete stays possible
// per this project's soft-delete-only convention).
const SALE_FROZEN_FIELDS = [
  "items",
  "subtotalAmount",
  "totalDiscount",
  "totalGstAmount",
  "totalProfit",
  "totalProfitAfterGst",
  "totalAmount",
  "customerId",
  "customerSnapshot",
  "branchId",
  "saleDate",
];

// Captures the persisted status at load time, before any in-memory
// modification - post('init') fires only when a document is hydrated
// from the database (not on `new Sale()`/.create()), so this never
// runs for a genuinely new document.
salesSchema.post("init", function () {
  this.$locals.wasFrozen = this.status !== "DRAFT";
});

// Promise-style middleware (no `next` parameter) - Mongoose 9 removed
// callback-style hooks entirely; a `next` argument is simply never
// passed, regardless of function signature. Throwing rejects.
salesSchema.pre("save", function () {
  if (this.isNew) return;
  if (!this.$locals.wasFrozen) return;

  const modifiedFrozenFields = SALE_FROZEN_FIELDS.filter((field) => this.isModified(field));
  if (modifiedFrozenFields.length > 0) {
    throw new Error(
      `Cannot modify ${modifiedFrozenFields.join(", ")} on a sale that is no longer DRAFT - ` +
      `these fields are frozen once a sale is finalized. Payment fields and status remain editable.`
    );
  }
});

// ============================================================
// QUERY-LEVEL FREEZE PROTECTION
// ============================================================
// Same reasoning as Purchase: updateOne/updateMany/findOneAndUpdate
// never construct a Document and never trigger pre('save'), so they
// bypass the guard above entirely. No controller currently does this
// against Sale (confirmed by a full-backend search - there is no
// update route for Sale at all today), but the guard is added
// proactively here for the same reason it's needed on Purchase, so a
// future update-style Sale controller can't silently reintroduce the
// same bypass.
async function guardSaleQueryUpdate() {
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

  const touchedFrozen = SALE_FROZEN_FIELDS.filter((f) => touchedPaths.has(f));
  if (touchedFrozen.length === 0) return;

  const nonDraftMatchCount = await this.model.countDocuments({
    ...this.getQuery(),
    status: { $ne: "DRAFT" },
  });

  if (nonDraftMatchCount > 0) {
    throw new Error(
      `Cannot modify ${touchedFrozen.join(", ")} via a query-level update - this would affect ` +
      `at least one sale that is no longer DRAFT, where these fields are frozen.`
    );
  }
}

salesSchema.pre("updateOne", { document: false, query: true }, guardSaleQueryUpdate);
salesSchema.pre("updateMany", guardSaleQueryUpdate);
salesSchema.pre("findOneAndUpdate", guardSaleQueryUpdate);

// ============================================================
// HARD-DELETE PROTECTION
// ============================================================
// Soft-delete only (isDeleted/deletedAt) - no legitimate hard-delete
// workflow exists at any stage of a Sale's lifecycle.
const SALE_HARD_DELETE_ERROR = new Error(
  "Sale records cannot be hard-deleted - use the soft-delete (isDeleted/deletedAt) workflow instead."
);

salesSchema.pre("deleteOne", { document: false, query: true }, function () {
  throw SALE_HARD_DELETE_ERROR;
});
salesSchema.pre("deleteMany", function () {
  throw SALE_HARD_DELETE_ERROR;
});
salesSchema.pre("findOneAndDelete", function () {
  throw SALE_HARD_DELETE_ERROR;
});
salesSchema.pre("deleteOne", { document: true, query: false }, function () {
  throw SALE_HARD_DELETE_ERROR;
});

// ============================================================
// MODEL
// ============================================================

const Sale = mongoose.model("Sale", salesSchema);

export default Sale;


