// controllers/purchase/getAllPurchases.controller.js
import mongoose from "mongoose";
import Purchase from "../../models/Purchase.modal.js";
import Vendor from "../../models/Vendor.modal.js";
import Product from "../../models/Product.modal.js";
import Branch from "../../models/Branch.modal.js";
import PendingReceive from "../../models/PendingReceive.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import paginate from "../../utils/pagination.js";

const PAYMENT_METHODS = ["CASH", "UPI", "CARD", "NET_BANKING", "CHEQUE", "EMI"];
const STATUS_VALUES = ["DRAFT", "COMPLETED", "CANCELLED"];
const PAYMENT_STATUS_VALUES = ["PAID", "PENDING", "PARTIAL"];
const PO_TYPE_VALUES = ["CENTRAL", "BRANCH"];

// Columns whose value isn't a plain top-level Purchase field sortable by
// a simple find().sort() - either it lives on the first item's own
// subdocument (purchasePrice/serialNumber), or entirely off-document on
// ProductSerial/Product (modelNumber/description for a serialized vs
// non-serialized first item). Sorted in-memory on the full filtered set
// (already fetched for stats anyway - see allFiltered below) instead of
// an aggregation $lookup, to keep the "one Purchase document = one row"
// find() behavior intact for a CENTRAL purchase split across branches.
const CUSTOM_SORT_FIELDS = new Set(["modelNumber", "serialNumber", "description", "qty", "purchasePrice", "totalAmount", "paidAmount", "pendingAmount"]);
const NUMERIC_SORT_FIELDS = new Set(["qty", "purchasePrice", "totalAmount", "paidAmount", "pendingAmount"]);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isSerializedItem = (item) => Array.isArray(item.serialNumbers) && item.serialNumbers.length > 0;
const itemQuantity = (item) => (isSerializedItem(item) ? item.serialNumbers.length : item.quantity || 0);
// Sum of every item's own cost price (purchasePrice x quantity,
// quantity always 1 for a serialized item) across the WHOLE purchase -
// what the list row's "Purchase Price" column shows/sorts by, distinct
// from totalAmount (the GST-inclusive invoice grand total).
const totalPurchasePriceOf = (items) =>
  (items || []).reduce((sum, item) => sum + (item.purchasePrice || 0) * (itemQuantity(item) || 1), 0);

// A purchase line is still "waiting" if its PendingReceive item status is
// PENDING or its ProductSerial status is ASSIGNED - anything else (including
// DAMAGED/REJECTED/SOLD) means the unit already physically arrived at some
// point, which is what "processed" means here (receive-completeness, not
// sellability).
const isLineProcessed = (status) => status !== "PENDING" && status !== "ASSIGNED";

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const weekKey = (d) => {
  const date = new Date(d);
  const firstDayOfWeek = new Date(date);
  firstDayOfWeek.setDate(date.getDate() - date.getDay());
  return firstDayOfWeek.toISOString().slice(0, 10);
};
const monthKey = (d) => new Date(d).toISOString().slice(0, 7);

// Groups by day/week/month depending on the actual span involved, so the
// trend array stays small regardless of how much history matches the
// filter - never one bucket per purchase.
const buildPurchaseTrend = (purchases, startDate, endDate) => {
  if (purchases.length === 0) return [];

  let grouping = "month";
  if (startDate && endDate) {
    const spanDays = (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24);
    grouping = spanDays <= 31 ? "day" : spanDays <= 180 ? "week" : "month";
  } else {
    const dates = purchases.map((p) => new Date(p.purchaseDate).getTime()).filter((t) => !Number.isNaN(t));
    if (dates.length > 0) {
      const spanDays = (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24);
      grouping = spanDays <= 31 ? "day" : spanDays <= 180 ? "week" : "month";
    }
  }

  const keyFn = grouping === "day" ? dayKey : grouping === "week" ? weekKey : monthKey;

  const buckets = new Map();
  for (const p of purchases) {
    if (!p.purchaseDate) continue;
    const key = keyFn(p.purchaseDate);
    if (!buckets.has(key)) buckets.set(key, { purchaseCount: 0, purchaseAmount: 0 });
    const b = buckets.get(key);
    b.purchaseCount += 1;
    b.purchaseAmount += p.totalAmount || 0;
  }

  return [...buckets.entries()]
    .map(([date, v]) => ({ date, purchaseCount: v.purchaseCount, purchaseAmount: round2(v.purchaseAmount) }))
    .sort((a, b) => a.date.localeCompare(b.date));
};

const emptyStatsPayload = (page, limit) => ({
  purchases: [],
  stats: {
    overview: { total: 0, totalAmount: 0 },
    purchaseStatus: { completed: 0, draft: 0, cancelled: 0 },
    paymentStatus: { paid: 0, partialPayment: 0, unpaid: 0 },
    financial: { totalPurchaseAmount: 0, totalPaidAmount: 0, totalOutstandingAmount: 0 },
    totalPurchases: 0, totalPurchaseAmount: 0, totalPaidAmount: 0, totalPendingAmount: 0,
    paidPurchaseCount: 0, partialPurchaseCount: 0, pendingPurchaseCount: 0,
    centralPurchaseCount: 0, branchPurchaseCount: 0,
    totalItemLines: 0, totalQuantity: 0,
    serializedItemCount: 0, serializedQuantity: 0,
    nonSerializedItemCount: 0, nonSerializedQuantity: 0,
    totalGstAmount: 0, gstApplicableItemCount: 0, gstNonApplicableItemCount: 0,
    totalVendors: 0, totalBranches: 0,
    pendingReceivePurchaseCount: 0, completedReceivePurchaseCount: 0,
  },
  paymentStats: { totalPurchaseAmount: 0, totalPaidAmount: 0, totalPendingAmount: 0, paidPurchaseCount: 0, partialPurchaseCount: 0, pendingPurchaseCount: 0, paymentMethodStats: [] },
  gstStats: { totalGstAmount: 0, gstApplicableItemCount: 0, gstNonApplicableItemCount: 0, gstRateBreakdown: [] },
  productStats: { totalUniqueProducts: 0, totalItemLines: 0, totalQuantity: 0, serializedItemCount: 0, serializedQuantity: 0, nonSerializedItemCount: 0, nonSerializedQuantity: 0 },
  amountStats: { subtotal: 0, gstAmount: 0, totalPurchaseAmount: 0, paidAmount: 0, pendingAmount: 0 },
  receiveStats: { pendingPurchaseCount: 0, partiallyReceivedCount: 0, completedReceiveCount: 0 },
  branchStats: [],
  vendorStats: { totalUniqueVendors: 0, topVendors: [] },
  purchaseTrend: [],
  pagination: { total: 0, page: parseInt(page) || 1, limit: parseInt(limit) || 10, totalPages: 1, currentPage: parseInt(page) || 1, totalRecords: 0, hasNextPage: false, hasPreviousPage: false },
  filters: {},
});

export const getAllPurchasesController = async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const { search, status, paymentStatus, poType, vendorId, branchId, startDate, endDate, modelNumber, sortBy, sortOrder } = req.query;
    const user = req.user;

    // ---- sort ----
    // Only these two columns are sortable from the list UI. Vendor sorts
    // by vendorSnapshot.name (a plain string already stored on every
    // purchase document) rather than the populated vendorId ref, so it
    // stays a single indexed find().sort() - no aggregation/$lookup
    // needed, and it sorts consistently even for purchases whose vendor
    // was later deleted.
    const order = sortOrder === "asc" ? 1 : -1;
    const isCustomSort = CUSTOM_SORT_FIELDS.has(sortBy);
    const sortSpec =
      sortBy === "vendor"
        ? { "vendorSnapshot.name": order, purchaseDate: -1 }
        : { purchaseDate: order, createdAt: -1 };

    // ============================================================
    // 1. BUILD FILTER
    // ============================================================
    const filter = { isDeleted: false };
    const andConditions = [];

    if (status && status !== "ALL" && STATUS_VALUES.includes(status)) {
      filter.status = status;
    }
    if (paymentStatus && paymentStatus !== "ALL" && PAYMENT_STATUS_VALUES.includes(paymentStatus)) {
      filter.paymentStatus = paymentStatus;
    }
    if (poType && poType !== "ALL" && PO_TYPE_VALUES.includes(poType)) {
      filter.poType = poType;
    }
    if (vendorId && vendorId !== "ALL" && mongoose.Types.ObjectId.isValid(vendorId)) {
      filter.vendorId = vendorId;
    }
    // Business purchase date, not record-creation timestamp - matches
    // what "date filter" means on an ERP purchase list, and is what
    // purchaseTrend groups by below.
    if (startDate || endDate) {
      filter.purchaseDate = {};
      if (startDate) filter.purchaseDate.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.purchaseDate.$lte = end;
      }
    }

    // ---- branch scoping ----
    // A BRANCH (direct-receive) purchase carries its branch at the top
    // level. A CENTRAL purchase has branchId:null and carries the
    // destination branch per item instead (items[].branchId - always
    // set for both purchase types by createPurchase.controller.js).
    // Matching both via $or on a plain find() (never aggregate+$unwind)
    // is what keeps a CENTRAL purchase split across several branches as
    // exactly one row - find() never fans a document out per matching
    // array element.
    const branchScopeCondition = (id) => ({ $or: [{ branchId: id }, { "items.branchId": id }] });

    if (user.role === "SUPER_ADMIN") {
      if (branchId && branchId !== "ALL" && mongoose.Types.ObjectId.isValid(branchId)) {
        andConditions.push(branchScopeCondition(branchId));
      }
    } else {
      // BRANCH_ADMIN / STAFF - always scoped to their own branch
      // regardless of what the client sends. A client-supplied branchId
      // for another branch is never honored - this is what actually
      // prevents cross-branch data exposure, not just "trusting" a
      // matching query param.
      if (!user.branchId) {
        return successResponse(res, "Purchases retrieved successfully", emptyStatsPayload(page, limit));
      }
      andConditions.push(branchScopeCondition(user.branchId));
    }

    // ---- model number filter (click-to-filter chip) ----
    // Model Number lives on the Product master for a serialized product
    // (one product = one master model number, per-unit modelNumber on
    // ProductSerial is display-only elsewhere) - resolve matching
    // Products once, then match purchases whose items reference one.
    if (modelNumber && modelNumber.trim() !== "") {
      const modelRegex = new RegExp(escapeRegex(modelNumber.trim()), "i");
      const matchingModelProducts = await Product.find({
        isDeleted: false,
        modelNumber: modelRegex,
      }).select("_id");
      andConditions.push({
        "items.productId": { $in: matchingModelProducts.map((p) => p._id) },
      });
    }

    // ---- search ----
    if (search && search.trim() !== "") {
      const searchTerm = search.trim();
      const searchRegex = new RegExp(escapeRegex(searchTerm), "i");

      const searchConditions = [
        { purchaseNumber: searchRegex },
        { reference: searchRegex },
        { "vendorSnapshot.name": searchRegex },
        { "vendorSnapshot.gstNumber": searchRegex },
        { "items.serialNumbers.serialNumber": searchRegex },
        { "items.batches.batchNumber": searchRegex },
      ];

      // Vendor name/phone/GST - covers purchases whose vendorSnapshot is
      // missing (pre-snapshot legacy records) or has since drifted from
      // the live vendor. One bounded query, not per-purchase.
      const matchingVendors = await Vendor.find({
        isDeleted: false,
        $or: [{ name: searchRegex }, { phone: searchRegex }, { gstNumber: searchRegex }],
      }).select("_id");
      if (matchingVendors.length > 0) {
        searchConditions.push({ vendorId: { $in: matchingVendors.map((v) => v._id) } });
      }

      // Product name/code -> resolve matching productIds, then match
      // against the embedded items.productId reference. One bounded
      // query, not per-purchase.
      const matchingProducts = await Product.find({
        isDeleted: false,
        $or: [{ name: searchRegex }, { productCode: searchRegex }],
      }).select("_id");
      if (matchingProducts.length > 0) {
        searchConditions.push({ "items.productId": { $in: matchingProducts.map((p) => p._id) } });
      }

      andConditions.push({ $or: searchConditions });
    }

    if (andConditions.length > 0) {
      filter.$and = andConditions;
    }

    // ============================================================
    // 2. FETCH - the paginated/populated page for display, and the
    // full filtered set (lean, unpopulated) as the single source for
    // every statistics object below. Both use the exact same `filter`,
    // so stats always match what the active filters show.
    // ============================================================

    const populateFields = [
      ["vendorId", "name phone email gstNumber"],
      ["branchId", "name code"],
      ["createdBy", "name email"],
      ["updatedBy", "name email"],
      ["items.productId", "name productCode category isSerialized hsnCode description modelNumber"],
    ];
    const withPopulate = (query) => populateFields.reduce((q, [path, select]) => q.populate(path, select), query);

    let purchasesPage;
    let allFiltered;

    if (isCustomSort) {
      allFiltered = await Purchase.find(filter).lean();

      // description for a serialized first item lives on its own
      // ProductSerial record; Model Number no longer does - it always
      // comes live from the Product master now - resolved here across
      // the WHOLE filtered set (not just the page about to be returned)
      // so the sort is correct before pagination happens. description
      // for a non-serialized first item comes from the Product master
      // instead. Only queried when actually needed by the requested
      // sort - every other custom-sortable field (purchasePrice/
      // totalAmount/paidAmount/pendingAmount/serialNumber) already lives
      // directly on the lean Purchase doc.
      let serialPreviewBySerialNumber = new Map();
      let productDescriptionById = new Map();
      let productModelNumberById = new Map();
      if (sortBy === "modelNumber" || sortBy === "description") {
        const serialNumbers = [];
        const productIds = [];
        for (const p of allFiltered) {
          const fi = (p.items || [])[0];
          if (!fi) continue;
          if (isSerializedItem(fi)) {
            const sn = fi.serialNumbers?.[0]?.serialNumber;
            if (sn) serialNumbers.push(sn);
          }
          if (fi.productId) productIds.push(fi.productId);
        }
        const [serials, products] = await Promise.all([
          serialNumbers.length > 0
            ? ProductSerial.find({ serialNumber: { $in: serialNumbers } }).select("serialNumber description").lean()
            : [],
          productIds.length > 0
            ? Product.find({ _id: { $in: productIds } }).select("description modelNumber").lean()
            : [],
        ]);
        serialPreviewBySerialNumber = new Map(serials.map((s) => [s.serialNumber, s]));
        productDescriptionById = new Map(products.map((pr) => [pr._id.toString(), pr.description || ""]));
        productModelNumberById = new Map(products.map((pr) => [pr._id.toString(), pr.modelNumber || ""]));
      }

      const sortValue = (p) => {
        const fi = (p.items || [])[0];
        if (!fi) return "";
        switch (sortBy) {
          case "qty":
            return itemQuantity(fi);
          case "purchasePrice":
            return totalPurchasePriceOf(p.items);
          case "totalAmount":
            return p.totalAmount || 0;
          case "paidAmount":
            return p.paidAmount || 0;
          case "pendingAmount":
            return p.pendingAmount || 0;
          case "serialNumber":
            return isSerializedItem(fi) ? (fi.serialNumbers?.[0]?.serialNumber || "") : "";
          case "modelNumber": {
            if (!isSerializedItem(fi)) return "";
            return (fi.productId && productModelNumberById.get(String(fi.productId))) || "";
          }
          case "description": {
            if (isSerializedItem(fi)) {
              const sn = fi.serialNumbers?.[0]?.serialNumber;
              return (sn && serialPreviewBySerialNumber.get(sn)?.description?.main) || "";
            }
            return productDescriptionById.get(String(fi.productId)) || "";
          }
          default:
            return "";
        }
      };

      const isNumeric = NUMERIC_SORT_FIELDS.has(sortBy);
      const sorted = [...allFiltered].sort((a, b) => {
        const va = sortValue(a);
        const vb = sortValue(b);
        return isNumeric ? order * ((va || 0) - (vb || 0)) : order * String(va).localeCompare(String(vb));
      });

      const pageIds = sorted.slice(skip, skip + limit).map((p) => p._id);
      const idOrder = new Map(pageIds.map((id, i) => [id.toString(), i]));

      const pageDocs = await withPopulate(Purchase.find({ _id: { $in: pageIds } }));
      purchasesPage = pageDocs.sort((a, b) => idOrder.get(a._id.toString()) - idOrder.get(b._id.toString()));
    } else {
      [purchasesPage, allFiltered] = await Promise.all([
        withPopulate(Purchase.find(filter)).sort(sortSpec).skip(skip).limit(limit),
        Purchase.find(filter).lean(),
      ]);
    }

    const totalRecords = allFiltered.length;

    // ============================================================
    // 2.5 FIRST-ITEM PREVIEW LOOKUP (page-bounded, cheap) - the
    // simplified Purchase List shows one row per Purchase document with
    // the FIRST item's Model/Serial/Description flattened directly onto
    // the row (a purchase with more items gets a "+N more" indicator
    // instead of a nested items table - most purchases are single-item
    // anyway). A serialized item's description lives on its own
    // ProductSerial record, never the item itself - batch-fetched here
    // by serial number, same lookup shape as
    // getPurchaseById.controller.js's serialsBySerialNumber map. Model
    // Number no longer needs this lookup at all - it always comes live
    // from the populated `items.productId.modelNumber` (Product master)
    // set up above in populateFields.
    // ============================================================
    const firstItemSerialNumbers = [];
    for (const purchaseDoc of purchasesPage) {
      const firstItem = (purchaseDoc.items || [])[0];
      const sn = firstItem?.serialNumbers?.[0]?.serialNumber;
      if (firstItem && isSerializedItem(firstItem) && sn) firstItemSerialNumbers.push(sn);
    }
    const firstItemSerials = firstItemSerialNumbers.length > 0
      ? await ProductSerial.find({ serialNumber: { $in: firstItemSerialNumbers } })
          .select("serialNumber description")
          .lean()
      : [];
    const serialPreviewByNumber = new Map(firstItemSerials.map((s) => [s.serialNumber, s]));

    // ============================================================
    // 3. RECEIVE-STATE LOOKUP - bounded to the CENTRAL purchases
    // actually present in the filtered set (BRANCH purchases are always
    // instantly received by architecture - direct-receive creates
    // Batch/BatchStock/ProductSerial as AVAILABLE immediately, so they
    // never need this lookup at all).
    // ============================================================

    const centralPurchaseIds = allFiltered.filter((p) => p.poType === "CENTRAL").map((p) => p._id);

    const [pendingReceives, productSerials] = centralPurchaseIds.length > 0
      ? await Promise.all([
          PendingReceive.find({ purchaseId: { $in: centralPurchaseIds } }).select("purchaseId items.status").lean(),
          ProductSerial.find({ purchaseId: { $in: centralPurchaseIds } }).select("purchaseId status").lean(),
        ])
      : [[], []];

    const pendingReceiveByPurchase = new Map();
    for (const pr of pendingReceives) {
      const key = pr.purchaseId.toString();
      if (!pendingReceiveByPurchase.has(key)) pendingReceiveByPurchase.set(key, []);
      pendingReceiveByPurchase.get(key).push(...pr.items.map((i) => i.status));
    }
    const serialsByPurchase = new Map();
    for (const s of productSerials) {
      const key = s.purchaseId.toString();
      if (!serialsByPurchase.has(key)) serialsByPurchase.set(key, []);
      serialsByPurchase.get(key).push(s.status);
    }

    const deriveReceiveStatus = (purchase) => {
      if (purchase.poType !== "CENTRAL") return "RECEIVED";

      const key = purchase._id.toString();
      const allStatuses = [...(pendingReceiveByPurchase.get(key) || []), ...(serialsByPurchase.get(key) || [])];
      if (allStatuses.length === 0) return "PENDING";

      const allProcessed = allStatuses.every(isLineProcessed);
      const noneProcessed = allStatuses.every((s) => !isLineProcessed(s));

      if (allProcessed) return "RECEIVED";
      if (noneProcessed) return "PENDING";
      return "PARTIAL";
    };

    // ============================================================
    // 4. TRANSFORM PAGE ROWS - bounded to `limit` purchases, cheap.
    // ============================================================

    const purchases = purchasesPage.map((purchaseDoc) => {
      const purchase = purchaseDoc.toObject();
      const items = purchase.items || [];

      let serializedItemCount = 0, serializedQuantity = 0;
      let nonSerializedItemCount = 0, nonSerializedQuantity = 0;
      let totalGstAmount = 0;
      // Sum of every item's own cost price (purchasePrice x quantity,
      // quantity always 1 for a serialized item) across the WHOLE
      // purchase - distinct from totalAmount (the GST-inclusive invoice
      // grand total) and from a single item's own unit price. This is
      // what the list row's "Purchase Price" column shows now, instead
      // of just the first item's price.
      let totalPurchasePrice = 0;

      for (const item of items) {
        const qty = itemQuantity(item);
        if (isSerializedItem(item)) {
          serializedItemCount += 1;
          serializedQuantity += qty;
        } else {
          nonSerializedItemCount += 1;
          nonSerializedQuantity += qty;
        }
        totalGstAmount += item.purchaseGstAmount || 0;
        totalPurchasePrice += (item.purchasePrice || 0) * (qty || 1);
      }

      const daysSince = Math.ceil((new Date() - new Date(purchase.createdAt)) / (1000 * 60 * 60 * 24));

      // First-item preview for the simplified list row - "-" for
      // Model/Serial on a non-serialized item, per the spec's explicit
      // non-serialized display rule.
      const firstItem = items[0] || null;
      let modelNumber = "-", serialNumber = "-", smallDescription = "";
      if (firstItem) {
        if (isSerializedItem(firstItem)) {
          const sn = firstItem.serialNumbers?.[0]?.serialNumber;
          const preview = sn ? serialPreviewByNumber.get(sn) : null;
          modelNumber = firstItem.productId?.modelNumber || "-";
          serialNumber = sn || "-";
          smallDescription = preview?.description?.main || "";
        } else {
          smallDescription = firstItem.productId?.description || "";
        }
      }
      const moreItemsCount = Math.max(0, items.length - 1);

      return {
        _id: purchase._id,
        purchaseNumber: purchase.purchaseNumber,
        purchaseDate: purchase.purchaseDate,
        modelNumber,
        serialNumber,
        smallDescription,
        moreItemsCount,
        totalPurchasePrice,
        poType: purchase.poType,
        vendorId: purchase.vendorId ? {
          _id: purchase.vendorId._id,
          name: purchase.vendorId.name,
          phone: purchase.vendorId.phone,
          email: purchase.vendorId.email,
          gstNumber: purchase.vendorId.gstNumber,
        } : null,
        vendorSnapshot: purchase.vendorSnapshot || null,
        branchId: purchase.branchId ? {
          _id: purchase.branchId._id,
          name: purchase.branchId.name,
          code: purchase.branchId.code,
        } : null,
        reference: purchase.reference || "",
        paymentStatus: purchase.paymentStatus,
        paidAmount: purchase.paidAmount,
        pendingAmount: purchase.pendingAmount,
        paymentDetails: purchase.paymentDetails || [],
        invoiceFile: purchase.invoiceFile,
        signatureFile: purchase.signatureFile,
        systemInvoiceFile: purchase.systemInvoiceFile,
        status: purchase.status,
        totalAmount: purchase.totalAmount,
        roundOff: purchase.roundOff,
        roundOffAmount: purchase.roundOffAmount,
        notes: purchase.notes,
        createdBy: purchase.createdBy ? { _id: purchase.createdBy._id, name: purchase.createdBy.name, email: purchase.createdBy.email } : null,
        updatedBy: purchase.updatedBy ? { _id: purchase.updatedBy._id, name: purchase.updatedBy.name, email: purchase.updatedBy.email } : null,
        isDeleted: purchase.isDeleted,
        createdAt: purchase.createdAt,
        updatedAt: purchase.updatedAt,

        items: items.map((item) => ({
          _id: item._id,
          productId: item.productId ? {
            _id: item.productId._id,
            name: item.productId.name,
            productCode: item.productId.productCode,
            category: item.productId.category,
            isSerialized: item.productId.isSerialized,
            hsnCode: item.productId.hsnCode,
          } : null,
          quantity: item.quantity,
          serialNumbers: item.serialNumbers || [],
          batches: item.batches || [],
          purchasePrice: item.purchasePrice,
          sellingPrice: item.sellingPrice,
          totalPrice: item.totalPrice,
          gstApplicable: item.gstApplicable,
          hsnCode: item.hsnCode,
          purchaseGstPercent: item.purchaseGstPercent,
          purchaseGstAmount: item.purchaseGstAmount,
          branchId: item.branchId,
        })),

        // item summary (section 7) - deep per-serial/per-batch detail
        // stays the Get By ID API's job, not this list.
        totalItemLines: items.length,
        totalQuantity: serializedQuantity + nonSerializedQuantity,
        serializedItemCount,
        serializedQuantity,
        nonSerializedItemCount,
        nonSerializedQuantity,
        totalGstAmount: round2(totalGstAmount),
        receiveStatus: deriveReceiveStatus(purchase),

        // kept for backward compatibility with the existing frontend
        itemCount: items.length,
        daysSince,
        isOverdue: purchase.status === "DRAFT" && daysSince > 7,
      };
    });

    // ============================================================
    // 5. AGGREGATE STATS - over the ENTIRE filtered set (allFiltered),
    // not just the current page. Every purchase's items[]/paymentDetails[]
    // are already embedded in what we fetched, so this is plain JS
    // reduction - no further per-purchase queries.
    // ============================================================

    const totalPurchaseAmount = round2(allFiltered.reduce((s, p) => s + (p.totalAmount || 0), 0));
    const totalPaidAmount = round2(allFiltered.reduce((s, p) => s + (p.paidAmount || 0), 0));
    const totalPendingAmount = round2(allFiltered.reduce((s, p) => s + (p.pendingAmount || 0), 0));

    const paidPurchaseCount = allFiltered.filter((p) => p.paymentStatus === "PAID").length;
    const partialPurchaseCount = allFiltered.filter((p) => p.paymentStatus === "PARTIAL").length;
    const pendingPurchaseCount = allFiltered.filter((p) => p.paymentStatus === "PENDING").length;

    const centralPurchaseCount = allFiltered.filter((p) => p.poType === "CENTRAL").length;
    const branchPurchaseCount = allFiltered.filter((p) => p.poType === "BRANCH").length;

    let totalItemLinesAll = 0, totalQuantityAll = 0;
    let serializedItemCountAll = 0, serializedQuantityAll = 0;
    let nonSerializedItemCountAll = 0, nonSerializedQuantityAll = 0;
    let totalGstAmountAll = 0, gstApplicableItemCountAll = 0, gstNonApplicableItemCountAll = 0;

    const gstRateMap = new Map(); // percent -> { itemCount, gstAmount }
    const branchAgg = new Map(); // branchId -> { purchaseIds, purchaseAmount, paidAmount, pendingAmount, itemLineCount, quantity }
    const vendorAgg = new Map(); // vendorId -> { vendorId, vendorName, purchaseCount, purchaseAmount }
    const paymentMethodAgg = new Map(); // method -> { amount, transactionCount }
    const productIdSet = new Set();
    const branchIdSet = new Set();

    for (const purchase of allFiltered) {
      const items = purchase.items || [];
      totalItemLinesAll += items.length;

      // Per-purchase branch item-totals, needed to prorate this
      // purchase's paidAmount/pendingAmount across the branches its
      // items touched - see the schema-limitation note in the summary
      // (payment is recorded per-purchase, never per-branch-item).
      const branchItemTotals = new Map();
      let purchaseItemsTotal = 0;

      for (const item of items) {
        if (item.productId) productIdSet.add(item.productId.toString());

        const serialized = isSerializedItem(item);
        const qty = itemQuantity(item);

        totalQuantityAll += qty;
        if (serialized) { serializedItemCountAll++; serializedQuantityAll += qty; }
        else { nonSerializedItemCountAll++; nonSerializedQuantityAll += qty; }

        const gstAmt = item.purchaseGstAmount || 0;
        totalGstAmountAll += gstAmt;
        if (item.gstApplicable) gstApplicableItemCountAll++; else gstNonApplicableItemCountAll++;

        const pct = item.purchaseGstPercent || 0;
        if (!gstRateMap.has(pct)) gstRateMap.set(pct, { itemCount: 0, gstAmount: 0 });
        const gstBucket = gstRateMap.get(pct);
        gstBucket.itemCount++;
        gstBucket.gstAmount += gstAmt;

        // Branch attribution is purely item-level, uniform for BRANCH
        // and CENTRAL alike (item.branchId is always the resolved
        // destination branch for both, per createPurchase.controller.js).
        // For a BRANCH purchase every item shares the same branchId, so
        // this naturally reproduces "whole purchase attributed to that
        // one branch" without any special-casing by poType.
        if (item.branchId) {
          const bKey = item.branchId.toString();
          branchIdSet.add(bKey);
          const lineTotal = item.totalPrice || 0;
          purchaseItemsTotal += lineTotal;
          branchItemTotals.set(bKey, (branchItemTotals.get(bKey) || 0) + lineTotal);

          if (!branchAgg.has(bKey)) {
            branchAgg.set(bKey, { purchaseIds: new Set(), purchaseAmount: 0, paidAmount: 0, pendingAmount: 0, itemLineCount: 0, quantity: 0 });
          }
          const bAgg = branchAgg.get(bKey);
          bAgg.purchaseIds.add(purchase._id.toString());
          bAgg.purchaseAmount += lineTotal;
          bAgg.itemLineCount += 1;
          bAgg.quantity += qty;
        }
      }

      // Prorate paidAmount/pendingAmount across branches by each
      // branch's exact share of this purchase's item total.
      if (purchaseItemsTotal > 0) {
        for (const [bKey, branchTotal] of branchItemTotals.entries()) {
          const share = branchTotal / purchaseItemsTotal;
          const bAgg = branchAgg.get(bKey);
          bAgg.paidAmount += (purchase.paidAmount || 0) * share;
          bAgg.pendingAmount += (purchase.pendingAmount || 0) * share;
        }
      }

      // Vendor stats - vendorSnapshot.name is the historical name (never
      // re-derived from the live Vendor record), matching the
      // historical-accuracy rule.
      const vKey = purchase.vendorId ? purchase.vendorId.toString() : "unknown";
      if (!vendorAgg.has(vKey)) {
        vendorAgg.set(vKey, {
          vendorId: purchase.vendorId || null,
          vendorName: purchase.vendorSnapshot?.name || "Unknown Vendor",
          purchaseCount: 0,
          purchaseAmount: 0,
        });
      }
      const vAgg = vendorAgg.get(vKey);
      vAgg.purchaseCount += 1;
      vAgg.purchaseAmount += purchase.totalAmount || 0;

      // Payment method stats, straight from the embedded paymentDetails.
      for (const pd of purchase.paymentDetails || []) {
        const method = pd.paymentMethod || "CASH";
        if (!paymentMethodAgg.has(method)) paymentMethodAgg.set(method, { amount: 0, transactionCount: 0 });
        const pAgg = paymentMethodAgg.get(method);
        pAgg.amount += pd.amount || 0;
        pAgg.transactionCount += 1;
      }
    }

    // ---- receiveStats (purchase-level, whole filtered set) ----
    let receivePending = 0, receivePartial = 0, receiveCompleted = 0;
    for (const purchase of allFiltered) {
      const st = deriveReceiveStatus(purchase);
      if (st === "PENDING") receivePending++;
      else if (st === "PARTIAL") receivePartial++;
      else receiveCompleted++;
    }

    // ---- vendorStats ----
    const totalUniqueVendors = vendorAgg.size;
    const topVendors = [...vendorAgg.values()]
      .map((v) => ({ vendorId: v.vendorId, vendorName: v.vendorName, purchaseCount: v.purchaseCount, purchaseAmount: round2(v.purchaseAmount) }))
      .sort((a, b) => b.purchaseAmount - a.purchaseAmount)
      .slice(0, 10);

    // ---- gstStats ----
    const gstRateBreakdown = [...gstRateMap.entries()]
      .map(([percentage, v]) => ({ percentage, itemCount: v.itemCount, gstAmount: round2(v.gstAmount) }))
      .sort((a, b) => a.percentage - b.percentage);

    // ---- paymentStats ----
    const paymentMethodStats = PAYMENT_METHODS
      .filter((m) => paymentMethodAgg.has(m))
      .map((m) => ({ paymentMethod: m, amount: round2(paymentMethodAgg.get(m).amount), transactionCount: paymentMethodAgg.get(m).transactionCount }));

    // ---- branchStats (SUPER_ADMIN only - a Branch Admin only ever sees
    // their own branch's data anyway, so a branch breakdown adds nothing
    // for them and costs an extra query) ----
    let branchStats = [];
    if (user.role === "SUPER_ADMIN" && branchAgg.size > 0) {
      const branchIds = [...branchAgg.keys()];
      const branchDocs = await Branch.find({ _id: { $in: branchIds } }).select("name code").lean();
      const branchInfoMap = new Map(branchDocs.map((b) => [b._id.toString(), b]));

      branchStats = branchIds
        .map((bKey) => {
          const agg = branchAgg.get(bKey);
          const info = branchInfoMap.get(bKey);
          return {
            branchId: bKey,
            branchName: info?.name || "Unknown Branch",
            branchCode: info?.code || "",
            purchaseCount: agg.purchaseIds.size,
            purchaseAmount: round2(agg.purchaseAmount),
            paidAmount: round2(agg.paidAmount),
            pendingAmount: round2(agg.pendingAmount),
            itemLineCount: agg.itemLineCount,
            quantity: agg.quantity,
          };
        })
        .sort((a, b) => b.purchaseAmount - a.purchaseAmount);
    }

    // ---- amountStats ----
    const roundOffTotal = allFiltered.reduce((s, p) => s + (p.roundOff ? p.roundOffAmount || 0 : 0), 0);
    const amountStats = {
      subtotal: round2(totalPurchaseAmount - totalGstAmountAll - roundOffTotal),
      gstAmount: round2(totalGstAmountAll),
      totalPurchaseAmount,
      paidAmount: totalPaidAmount,
      pendingAmount: totalPendingAmount,
    };

    // ---- purchaseTrend ----
    const purchaseTrend = buildPurchaseTrend(allFiltered, startDate, endDate);

    // ---- combined `stats` - legacy nested shape kept exactly as the
    // existing frontend (PurchaseStats.jsx) already reads it
    // (stats.overview / .purchaseStatus / .paymentStatus / .financial),
    // with the new flat fields added alongside, not replacing them. ----
    const stats = {
      overview: { total: totalRecords, totalAmount: totalPurchaseAmount },
      purchaseStatus: {
        completed: allFiltered.filter((p) => p.status === "COMPLETED").length,
        draft: allFiltered.filter((p) => p.status === "DRAFT").length,
        cancelled: allFiltered.filter((p) => p.status === "CANCELLED").length,
      },
      paymentStatus: { paid: paidPurchaseCount, partialPayment: partialPurchaseCount, unpaid: pendingPurchaseCount },
      financial: { totalPurchaseAmount, totalPaidAmount, totalOutstandingAmount: round2(totalPurchaseAmount - totalPaidAmount) },

      totalPurchases: totalRecords,
      totalPurchaseAmount,
      totalPaidAmount,
      totalPendingAmount,
      paidPurchaseCount,
      partialPurchaseCount,
      pendingPurchaseCount,
      centralPurchaseCount,
      branchPurchaseCount,
      totalItemLines: totalItemLinesAll,
      totalQuantity: totalQuantityAll,
      serializedItemCount: serializedItemCountAll,
      serializedQuantity: serializedQuantityAll,
      nonSerializedItemCount: nonSerializedItemCountAll,
      nonSerializedQuantity: nonSerializedQuantityAll,
      totalGstAmount: round2(totalGstAmountAll),
      gstApplicableItemCount: gstApplicableItemCountAll,
      gstNonApplicableItemCount: gstNonApplicableItemCountAll,
      totalVendors: totalUniqueVendors,
      totalBranches: branchIdSet.size,
      // "still needs a receive action" (PENDING + PARTIAL combined) vs
      // "done" - the full 3-way split lives in receiveStats below.
      pendingReceivePurchaseCount: receivePending + receivePartial,
      completedReceivePurchaseCount: receiveCompleted,
    };

    const paymentStats = {
      totalPurchaseAmount,
      totalPaidAmount,
      totalPendingAmount,
      paidPurchaseCount,
      partialPurchaseCount,
      pendingPurchaseCount,
      paymentMethodStats,
    };

    const gstStats = {
      totalGstAmount: round2(totalGstAmountAll),
      gstApplicableItemCount: gstApplicableItemCountAll,
      gstNonApplicableItemCount: gstNonApplicableItemCountAll,
      gstRateBreakdown,
    };

    const productStats = {
      totalUniqueProducts: productIdSet.size,
      totalItemLines: totalItemLinesAll,
      totalQuantity: totalQuantityAll,
      serializedItemCount: serializedItemCountAll,
      serializedQuantity: serializedQuantityAll,
      nonSerializedItemCount: nonSerializedItemCountAll,
      nonSerializedQuantity: nonSerializedQuantityAll,
    };

    const vendorStats = { totalUniqueVendors, topVendors };

    const receiveStats = {
      pendingPurchaseCount: receivePending,
      partiallyReceivedCount: receivePartial,
      completedReceiveCount: receiveCompleted,
    };

    // ============================================================
    // 6. PAGINATION - legacy field names kept, new names added
    // alongside (section 17).
    // ============================================================
    const totalPages = Math.max(1, Math.ceil(totalRecords / limit));
    const pagination = {
      total: totalRecords,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages,
      currentPage: parseInt(page),
      totalRecords,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    };

    // ============================================================
    // 7. RESPONSE
    // ============================================================
    return successResponse(res, "Purchases retrieved successfully", {
      purchases,
      stats,
      paymentStats,
      gstStats,
      productStats,
      amountStats,
      receiveStats,
      branchStats,
      vendorStats,
      purchaseTrend,
      pagination,
      filters: {
        search: search || "",
        status: status || "ALL",
        paymentStatus: paymentStatus || "ALL",
        poType: poType || "ALL",
        vendorId: vendorId || "ALL",
        branchId: branchId || "ALL",
        startDate: startDate || null,
        endDate: endDate || null,
        modelNumber: modelNumber || "",
      },
    });
  } catch (error) {
    console.error("Get Purchases Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve purchases", 500);
  }
};
