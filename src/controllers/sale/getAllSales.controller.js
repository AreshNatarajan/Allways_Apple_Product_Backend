// controllers/sale/getAllSales.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import Customer from "../../models/Customer.modal.js";
import Branch from "../../models/Branch.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import paginate from "../../utils/pagination.js";

const PAYMENT_METHODS = ["CASH", "UPI", "CARD", "NET_BANKING", "CHEQUE", "EMI"];
const STATUS_VALUES = ["DRAFT", "COMPLETED", "CANCELLED"];
const PAYMENT_STATUS_VALUES = ["PAID", "PARTIAL", "UNPAID"];
const PROCESS_STATUS_VALUES = ["PENDING_REVIEW", "APPROVED", "REJECTED"];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const itemQuantity = (item) => (item.isSerialized ? 1 : (item.quantity || 0));

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
// filter - never one bucket per sale. Mirrors buildPurchaseTrend exactly.
const buildSaleTrend = (sales, startDate, endDate) => {
    if (sales.length === 0) return [];

    let grouping = "month";
    if (startDate && endDate) {
        const spanDays = (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24);
        grouping = spanDays <= 31 ? "day" : spanDays <= 180 ? "week" : "month";
    } else {
        const dates = sales.map((s) => new Date(s.saleDate).getTime()).filter((t) => !Number.isNaN(t));
        if (dates.length > 0) {
            const spanDays = (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24);
            grouping = spanDays <= 31 ? "day" : spanDays <= 180 ? "week" : "month";
        }
    }

    const keyFn = grouping === "day" ? dayKey : grouping === "week" ? weekKey : monthKey;

    const buckets = new Map();
    for (const s of sales) {
        if (!s.saleDate) continue;
        const key = keyFn(s.saleDate);
        if (!buckets.has(key)) buckets.set(key, { saleCount: 0, saleAmount: 0 });
        const b = buckets.get(key);
        b.saleCount += 1;
        b.saleAmount += s.totalAmount || 0;
    }

    return [...buckets.entries()]
        .map(([date, v]) => ({ date, saleCount: v.saleCount, saleAmount: round2(v.saleAmount) }))
        .sort((a, b) => a.date.localeCompare(b.date));
};

const emptyStatsPayload = (page, limit) => ({
    sales: [],
    pagination: { total: 0, page: parseInt(page) || 1, limit: parseInt(limit) || 10, totalPages: 1, currentPage: parseInt(page) || 1, totalRecords: 0, hasNextPage: false, hasPreviousPage: false },
    stats: {
        overview: { totalSales: 0, totalSalesAmount: 0, totalPaidAmount: 0, totalOutstandingAmount: 0 },
        saleStatus: { completed: 0, draft: 0, cancelled: 0 },
        paymentStatus: { paid: 0, partial: 0, pending: 0 },
    },
    financial: { subtotal: 0, discount: 0, gstAmount: 0, totalAmount: 0, paidAmount: 0, pendingAmount: 0 },
    paymentStats: { totalSalesAmount: 0, totalPaidAmount: 0, totalPendingAmount: 0, paidSaleCount: 0, partialSaleCount: 0, unpaidSaleCount: 0, paymentMethodStats: [] },
    gstStats: { totalGstAmount: 0, gstApplicableItemCount: 0, gstNonApplicableItemCount: 0, gstRateBreakdown: [] },
    productStats: { totalUniqueProducts: 0, totalItemLines: 0, totalQuantity: 0, serializedItemCount: 0, serializedQuantity: 0, nonSerializedItemCount: 0, nonSerializedQuantity: 0 },
    customerStats: { totalUniqueCustomers: 0, topCustomers: [] },
    branchStats: [],
    saleTrend: [],
    filters: {},
});

export const getAllSalesController = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { search, status, paymentStatus, customerId, branchId, startDate, endDate, processStatus, modelNumber, sortBy, sortOrder } = req.query;
        const user = req.user;

        // ---- sort ----
        // Mirrors getAllPurchasesController exactly: only these two
        // columns are sortable from the list UI. Customer sorts by
        // customerSnapshot.name (a plain string already stored on every
        // sale document) rather than the populated customerId ref, so
        // it stays a single indexed find().sort() - no aggregation
        // needed, and it sorts consistently even for sales whose
        // customer was later deleted.
        const order = sortOrder === "asc" ? 1 : -1;
        const sortSpec =
            sortBy === "customer"
                ? { "customerSnapshot.name": order, saleDate: -1 }
                : { saleDate: order, createdAt: -1 };

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
        if (customerId && customerId !== "ALL" && mongoose.Types.ObjectId.isValid(customerId)) {
            filter.customerId = customerId;
        }
        // processStatus only ever exists on a non-SUPER_ADMIN-created
        // sale (see Sale.modal.js) - filtering by it implicitly excludes
        // every SUPER_ADMIN sale, no separate condition needed.
        if (processStatus && processStatus !== "ALL" && PROCESS_STATUS_VALUES.includes(processStatus)) {
            filter.processStatus = processStatus;
        }
        // Model Number is already stored flat on Sale.items[] (unlike
        // Purchase, which needed a Product-master lookup) - a direct
        // regex match against the embedded field, no extra query.
        if (modelNumber && modelNumber.trim() !== "") {
            andConditions.push({ "items.modelNumber": new RegExp(escapeRegex(modelNumber.trim()), "i") });
        }

        // Business sale date, not record-creation timestamp - matches
        // what "date filter" means on an ERP sale list, and is what
        // saleTrend groups by below. endDate normalized to end-of-day so
        // a same-day filter is inclusive.
        if (startDate || endDate) {
            filter.saleDate = {};
            if (startDate) filter.saleDate.$gte = new Date(startDate);
            if (endDate) {
                const end = new Date(endDate);
                end.setHours(23, 59, 59, 999);
                filter.saleDate.$lte = end;
            }
        }

        // ---- branch scoping ----
        // Sale.branchId is a single required top-level field (no
        // CENTRAL/multi-branch split like Purchase), so scoping is a
        // plain equality filter - no $or needed. Only SUPER_ADMIN may
        // filter by (or see across) branches; every other role is
        // always forced to their own branch regardless of what the
        // client sends, and a client-supplied branchId for another
        // branch is never honored - this is what actually prevents
        // cross-branch data exposure. (Previously delegated to the
        // shared getBranchFilter middleware, which has a real gap for
        // any role other than SUPER_ADMIN/BRANCH_ADMIN - e.g. STAFF got
        // an unscoped {} filter, seeing every branch's sales. Scoping is
        // now built inline here instead, matching Purchase's verified
        // pattern; the shared middleware itself is untouched since other
        // callers may depend on its current behavior.)
        if (user.role === "SUPER_ADMIN") {
            if (branchId && branchId !== "ALL" && mongoose.Types.ObjectId.isValid(branchId)) {
                filter.branchId = branchId;
            }
        } else {
            if (!user.branchId) {
                return successResponse(res, "Sales retrieved successfully", emptyStatsPayload(page, limit));
            }
            filter.branchId = user.branchId;
        }

        // ---- search ----
        if (search && search.trim() !== "" && search !== "undefined") {
            const searchTerm = search.trim();
            const searchRegex = new RegExp(escapeRegex(searchTerm), "i");

            const searchConditions = [
                // Sale Number doubles as Invoice Number - Sale has no
                // separate invoice-number field, saleNumber is already
                // invoice-formatted (e.g. "INV-1001").
                { saleNumber: searchRegex },
                { notes: searchRegex },
                { paymentStatus: searchRegex },
                { status: searchRegex },
                // Directly embedded on Sale.items[] - no cross-collection
                // query needed for these, unlike Purchase.
                { "items.productName": searchRegex },
                { "items.productCode": searchRegex },
                { "items.batchNumber": searchRegex },
                { "items.serialNumber": searchRegex },
                // Historical customer snapshot, directly on Sale.
                { "customerSnapshot.name": searchRegex },
                { "customerSnapshot.mobile": searchRegex },
                { "customerSnapshot.email": searchRegex },
            ];

            // Live Customer name/mobile/email/phone - covers sales whose
            // customerSnapshot is missing (pre-snapshot legacy records)
            // or has since drifted from the live customer. One bounded
            // query, not per-sale.
            const matchingCustomers = await Customer.find({
                isDeleted: false,
                $or: [
                    { name: searchRegex },
                    { mobile: searchRegex },
                    { email: searchRegex },
                    { phone: searchRegex },
                ],
            }).select("_id");
            if (matchingCustomers.length > 0) {
                searchConditions.push({ customerId: { $in: matchingCustomers.map((c) => c._id) } });
            }

            if (!isNaN(parseFloat(searchTerm))) {
                const numSearch = parseFloat(searchTerm);
                searchConditions.push({ totalAmount: numSearch }, { paidAmount: numSearch }, { pendingAmount: numSearch });
            }

            andConditions.push({ $or: searchConditions });
        }

        if (andConditions.length > 0) {
            filter.$and = andConditions;
        }

        // ============================================================
        // 2. FETCH - the paginated/populated page for display, and the
        // full filtered set (lean, unpopulated) as the single source
        // for every statistics object below. Both use the exact same
        // `filter`, so stats always match what the active filters show.
        // Replaces the previous 3-query pattern (find + countDocuments +
        // a second find for stats with fully duplicated filter-building
        // code) - totalRecords now derives from the lean array's length.
        // ============================================================

        const [salesPage, allFiltered] = await Promise.all([
            Sale.find(filter)
                .populate("customerId", "name mobile email phone")
                .populate("branchId", "name code")
                .populate("items.productId", "name productCode category isSerialized description")
                .populate("items.productSerialId", "serialNumber")
                .populate("createdBy", "name email")
                .populate("updatedBy", "name email")
                .populate("handledBy.userId", "name email")
                .populate("reviewedBy", "name email")
                .sort(sortSpec)
                .skip(skip)
                .limit(limit),
            Sale.find(filter).lean(),
        ]);

        const totalRecords = allFiltered.length;

        // ============================================================
        // 2.5 FIRST-ITEM DESCRIPTION LOOKUP (page-bounded, cheap) - the
        // simplified Sale List shows one row per Sale document with the
        // FIRST item's Model/Serial/Description flattened directly onto
        // the row (a sale with more items gets a "+N more" indicator
        // instead of a nested items table - mirrors Purchase's list).
        // modelNumber/serialNumber are already stored flat on
        // Sale.items[] (no lookup needed), but description isn't - a
        // serialized item's description lives on its own ProductSerial
        // record, batch-fetched here by productSerialId (a non-serialized
        // item's description comes from the already-populated
        // items.productId above instead).
        // ============================================================
        const firstItemSerialIds = [];
        for (const saleDoc of salesPage) {
            const firstItem = (saleDoc.items || [])[0];
            if (firstItem?.isSerialized && firstItem.productSerialId) {
                firstItemSerialIds.push(firstItem.productSerialId._id || firstItem.productSerialId);
            }
        }
        const firstItemSerials = firstItemSerialIds.length > 0
            ? await ProductSerial.find({ _id: { $in: firstItemSerialIds } }).select("description").lean()
            : [];
        const serialDescriptionById = new Map(firstItemSerials.map((s) => [s._id.toString(), s.description]));

        // ============================================================
        // 3. TRANSFORM PAGE ROWS - bounded to `limit` sales, cheap.
        // ============================================================

        const sales = salesPage.map((saleDoc) => {
            const sale = saleDoc.toObject();

            // First-item preview for the simplified list row - "-" for
            // Model/Serial on a non-serialized item, per the same
            // non-serialized display rule Purchase's list uses.
            const firstItem = (sale.items || [])[0] || null;
            let modelNumber = "-", serialNumber = "-", smallDescription = "";
            if (firstItem) {
                if (firstItem.isSerialized) {
                    modelNumber = firstItem.modelNumber || "-";
                    serialNumber = firstItem.serialNumber || "-";
                    const serialId = firstItem.productSerialId?._id?.toString() || firstItem.productSerialId?.toString();
                    smallDescription = serialDescriptionById.get(serialId)?.main || "";
                } else {
                    smallDescription = firstItem.productId?.description || "";
                }
            }
            const moreItemsCount = Math.max(0, (sale.items || []).length - 1);
            const itemSellingPrice = firstItem?.sellingPrice ?? null;

            return {
                _id: sale._id,
                saleNumber: sale.saleNumber,
                modelNumber,
                serialNumber,
                smallDescription,
                moreItemsCount,
                itemSellingPrice,
                customerId: sale.customerId ? {
                    _id: sale.customerId._id,
                    name: sale.customerId.name,
                    mobile: sale.customerId.mobile,
                    phone: sale.customerId.phone,
                    email: sale.customerId.email,
                } : null,
                customerSnapshot: sale.customerSnapshot || null,
                branchId: sale.branchId ? {
                    _id: sale.branchId._id,
                    name: sale.branchId.name,
                    code: sale.branchId.code,
                } : null,
                saleDate: sale.saleDate,
                // Accountability - handledBy/selfie stay unset for a
                // SUPER_ADMIN-created sale; processStatus stays null
                // there too (out of EOD review's scope, see Sale.modal.js).
                handledBy: sale.handledBy?.userId ? {
                    userId: sale.handledBy.userId._id,
                    name: sale.handledBy.name || sale.handledBy.userId.name || "",
                    role: sale.handledBy.role || "",
                } : null,
                selfie: sale.selfie?.url ? { key: sale.selfie.key, url: sale.selfie.url, uploadedAt: sale.selfie.uploadedAt } : null,
                processStatus: sale.processStatus || null,
                reviewedBy: sale.reviewedBy ? { _id: sale.reviewedBy._id, name: sale.reviewedBy.name, email: sale.reviewedBy.email } : null,
                reviewedAt: sale.reviewedAt || null,
                items: sale.items.map((item) => ({
                    _id: item._id,
                    productId: item.productId ? {
                        _id: item.productId._id,
                        name: item.productId.name,
                        productCode: item.productId.productCode,
                        category: item.productId.category,
                        isSerialized: item.productId.isSerialized,
                    } : null,
                    productName: item.productName || "",
                    productCode: item.productCode || "",
                    isSerialized: item.isSerialized,
                    productSerialId: item.productSerialId ? {
                        _id: item.productSerialId._id,
                        serialNumber: item.productSerialId.serialNumber,
                    } : null,
                    serialNumber: item.serialNumber,
                    modelNumber: item.modelNumber || "",
                    batchNumber: item.batchNumber || "",
                    quantity: item.quantity,
                    sellingPrice: item.sellingPrice,
                    purchasePrice: item.purchasePrice,
                    discount: item.discount || 0,
                    gstApplicable: item.gstApplicable,
                    gstPercent: item.gstPercent,
                    gstAmount: item.gstAmount,
                    hsnCode: item.hsnCode || "",
                    subtotal: item.subtotal,
                    totalPrice: item.finalAmount,
                })),
                subtotalAmount: sale.subtotalAmount,
                totalDiscount: sale.totalDiscount,
                totalGstAmount: sale.totalGstAmount,
                totalAmount: sale.totalAmount,
                paymentDetails: sale.paymentDetails || [],
                paymentStatus: sale.paymentStatus,
                paidAmount: sale.paidAmount,
                pendingAmount: sale.pendingAmount,
                status: sale.status || "COMPLETED",
                signatureFile: sale.signatureFile,
                notes: sale.notes,
                createdBy: sale.createdBy ? {
                    _id: sale.createdBy._id,
                    name: sale.createdBy.name,
                    email: sale.createdBy.email,
                } : null,
                updatedBy: sale.updatedBy ? {
                    _id: sale.updatedBy._id,
                    name: sale.updatedBy.name,
                    email: sale.updatedBy.email,
                } : null,
                createdAt: sale.createdAt,
                updatedAt: sale.updatedAt,
            };
        });

        // ============================================================
        // 4. AGGREGATE STATS - over the ENTIRE filtered set (allFiltered),
        // not just the current page. Every sale's items[]/paymentDetails[]
        // are already embedded in what we fetched, so this is plain JS
        // reduction - no further per-sale queries.
        // ============================================================

        const totalSalesAmount = round2(allFiltered.reduce((s, sale) => s + (sale.totalAmount || 0), 0));
        const totalPaidAmount = round2(allFiltered.reduce((s, sale) => s + (sale.paidAmount || 0), 0));
        const totalOutstandingAmount = round2(allFiltered.reduce((s, sale) => s + (sale.pendingAmount || 0), 0));
        const totalDiscountAll = round2(allFiltered.reduce((s, sale) => s + (sale.totalDiscount || 0), 0));
        const totalSubtotalAll = round2(allFiltered.reduce((s, sale) => s + (sale.subtotalAmount || 0), 0));

        const paidSaleCount = allFiltered.filter((s) => s.paymentStatus === "PAID").length;
        const partialSaleCount = allFiltered.filter((s) => s.paymentStatus === "PARTIAL").length;
        const unpaidSaleCount = allFiltered.filter((s) => s.paymentStatus === "UNPAID").length;

        let totalItemLinesAll = 0, totalQuantityAll = 0;
        let serializedItemCountAll = 0, serializedQuantityAll = 0;
        let nonSerializedItemCountAll = 0, nonSerializedQuantityAll = 0;
        let totalGstAmountAll = 0, gstApplicableItemCountAll = 0, gstNonApplicableItemCountAll = 0;

        const gstRateMap = new Map(); // percent -> { itemCount, gstAmount }
        const branchAgg = new Map(); // branchId -> { saleIds, saleAmount, paidAmount, pendingAmount, itemLineCount, quantity }
        const customerAgg = new Map(); // customerId -> { customerId, customerName, saleCount, saleAmount }
        const paymentMethodAgg = new Map(); // method -> { amount, transactionCount }
        const productIdSet = new Set();
        const branchIdSet = new Set();

        for (const sale of allFiltered) {
            const items = sale.items || [];
            totalItemLinesAll += items.length;

            for (const item of items) {
                if (item.productId) productIdSet.add(item.productId.toString());

                const qty = itemQuantity(item);
                totalQuantityAll += qty;
                if (item.isSerialized) { serializedItemCountAll++; serializedQuantityAll += qty; }
                else { nonSerializedItemCountAll++; nonSerializedQuantityAll += qty; }

                const gstAmt = item.gstAmount || 0;
                totalGstAmountAll += gstAmt;
                if (item.gstApplicable) gstApplicableItemCountAll++; else gstNonApplicableItemCountAll++;

                const pct = item.gstPercent || 0;
                if (!gstRateMap.has(pct)) gstRateMap.set(pct, { itemCount: 0, gstAmount: 0 });
                const gstBucket = gstRateMap.get(pct);
                gstBucket.itemCount++;
                gstBucket.gstAmount += gstAmt;
            }

            // Branch stats - a Sale belongs to exactly one branch, so no
            // proration is needed (unlike Purchase's CENTRAL multi-branch
            // split) - the sale's whole amount attributes to its one branch.
            if (sale.branchId) {
                const bKey = sale.branchId.toString();
                branchIdSet.add(bKey);
                if (!branchAgg.has(bKey)) {
                    branchAgg.set(bKey, { saleIds: new Set(), saleAmount: 0, paidAmount: 0, pendingAmount: 0, itemLineCount: 0, quantity: 0 });
                }
                const bAgg = branchAgg.get(bKey);
                bAgg.saleIds.add(sale._id.toString());
                bAgg.saleAmount += sale.totalAmount || 0;
                bAgg.paidAmount += sale.paidAmount || 0;
                bAgg.pendingAmount += sale.pendingAmount || 0;
                bAgg.itemLineCount += items.length;
                bAgg.quantity += items.reduce((s, it) => s + itemQuantity(it), 0);
            }

            // Customer stats - customerSnapshot.name is the historical
            // name (never re-derived from the live Customer record),
            // matching the historical-accuracy rule.
            const cKey = sale.customerId ? sale.customerId.toString() : "unknown";
            if (!customerAgg.has(cKey)) {
                customerAgg.set(cKey, {
                    customerId: sale.customerId || null,
                    customerName: sale.customerSnapshot?.name || "Unknown Customer",
                    saleCount: 0,
                    saleAmount: 0,
                });
            }
            const cAgg = customerAgg.get(cKey);
            cAgg.saleCount += 1;
            cAgg.saleAmount += sale.totalAmount || 0;

            // Payment method stats, straight from the embedded paymentDetails.
            for (const pd of sale.paymentDetails || []) {
                const method = pd.paymentMethod || "CASH";
                if (!paymentMethodAgg.has(method)) paymentMethodAgg.set(method, { amount: 0, transactionCount: 0 });
                const pAgg = paymentMethodAgg.get(method);
                pAgg.amount += pd.amount || 0;
                pAgg.transactionCount += 1;
            }
        }

        // ---- customerStats ----
        const totalUniqueCustomers = customerAgg.size;
        const topCustomers = [...customerAgg.values()]
            .map((c) => ({ customerId: c.customerId, customerName: c.customerName, saleCount: c.saleCount, saleAmount: round2(c.saleAmount) }))
            .sort((a, b) => b.saleAmount - a.saleAmount)
            .slice(0, 10);

        // ---- gstStats ----
        const gstRateBreakdown = [...gstRateMap.entries()]
            .map(([percentage, v]) => ({ percentage, itemCount: v.itemCount, gstAmount: round2(v.gstAmount) }))
            .sort((a, b) => a.percentage - b.percentage);

        // ---- paymentStats ----
        const paymentMethodStats = PAYMENT_METHODS
            .filter((m) => paymentMethodAgg.has(m))
            .map((m) => ({ paymentMethod: m, amount: round2(paymentMethodAgg.get(m).amount), transactionCount: paymentMethodAgg.get(m).transactionCount }));

        // ---- branchStats (SUPER_ADMIN only - a Branch Admin only ever
        // sees their own branch's data anyway, so a branch breakdown adds
        // nothing for them and costs an extra query) ----
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
                        saleCount: agg.saleIds.size,
                        saleAmount: round2(agg.saleAmount),
                        paidAmount: round2(agg.paidAmount),
                        pendingAmount: round2(agg.pendingAmount),
                        itemLineCount: agg.itemLineCount,
                        quantity: agg.quantity,
                    };
                })
                .sort((a, b) => b.saleAmount - a.saleAmount);
        }

        // ---- financial (mirrors Purchase's amountStats) ----
        const financial = {
            subtotal: totalSubtotalAll,
            discount: totalDiscountAll,
            gstAmount: round2(totalGstAmountAll),
            totalAmount: totalSalesAmount,
            paidAmount: totalPaidAmount,
            pendingAmount: totalOutstandingAmount,
        };

        // ---- saleTrend ----
        const saleTrend = buildSaleTrend(allFiltered, startDate, endDate);

        // ---- combined `stats` - legacy nested shape kept exactly as the
        // existing frontend already reads it (stats.overview /
        // .saleStatus / .paymentStatus), new stat objects added alongside
        // as top-level keys, not replacing this. ----
        const stats = {
            overview: {
                totalSales: totalRecords,
                totalSalesAmount,
                totalPaidAmount,
                totalOutstandingAmount,
                totalItemLines: totalItemLinesAll,
                totalQuantity: totalQuantityAll,
                serializedItemCount: serializedItemCountAll,
                serializedQuantity: serializedQuantityAll,
                nonSerializedItemCount: nonSerializedItemCountAll,
                nonSerializedQuantity: nonSerializedQuantityAll,
            },
            saleStatus: {
                completed: allFiltered.filter((s) => s.status === "COMPLETED").length,
                draft: allFiltered.filter((s) => s.status === "DRAFT").length,
                cancelled: allFiltered.filter((s) => s.status === "CANCELLED").length,
            },
            paymentStatus: {
                paid: paidSaleCount,
                partial: partialSaleCount,
                pending: unpaidSaleCount,
            },
        };

        const paymentStats = {
            totalSalesAmount,
            totalPaidAmount,
            totalPendingAmount: totalOutstandingAmount,
            paidSaleCount,
            partialSaleCount,
            unpaidSaleCount,
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

        const customerStats = { totalUniqueCustomers, topCustomers };

        // ============================================================
        // 5. PAGINATION - legacy field names kept, new names added
        // alongside (matches Purchase's own enhancement).
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
        // 6. RESPONSE
        // ============================================================
        return successResponse(res, "Sales retrieved successfully", {
            sales,
            pagination,
            stats,
            financial,
            paymentStats,
            gstStats,
            productStats,
            customerStats,
            branchStats,
            saleTrend,
            filters: {
                search: search || "",
                status: status || "ALL",
                paymentStatus: paymentStatus || "ALL",
                customerId: customerId || "ALL",
                branchId: branchId || "ALL",
                startDate: startDate || null,
                endDate: endDate || null,
                processStatus: processStatus || "ALL",
                modelNumber: modelNumber || "",
            },
        });
    } catch (error) {
        console.error("Get Sales Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve sales", 500);
    }
};
