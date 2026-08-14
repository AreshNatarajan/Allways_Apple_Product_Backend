// controllers/reports/getInOutReport.controller.js
import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Sale from "../../models/Sale.modal.js";
import Branch from "../../models/Branch.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

/**
 * 📋 IN / OUT REGISTER REPORT (simplified, auditor-facing)
 *
 * Returns exactly the rows the frontend needs to build the IN/OUT Excel
 * workbook(s) - no GST column, no stats, no internal IDs in the sheet
 * itself. Every row also carries its own `gstApplicable` flag (metadata
 * only, never rendered as a column) so the frontend can build BOTH the
 * Overall report and a GST-Applicable-only report from this same one
 * fetch, by filtering client-side, exactly like the Purchase/Sale list
 * screens' own filter patterns - never a second API call. Every field
 * here is read straight from the existing business records (Purchase/
 * Sale/ProductSerial/BatchStock/Product), never recalculated - this
 * endpoint only selects and relabels, it does not compute anything new.
 *
 * IN = one row per physical unit received (ProductSerial, serialized)
 * or per batch received (BatchStock, non-serialized), joined back to
 * the Purchase that created it for date/vendor/payment info.
 * OUT = one row per sale line item (Sale.items, both types), joined to
 * ProductSerial (serialized) or Product (non-serialized) for the
 * short description.
 *
 * Vendor/customer identity uses the frozen vendorSnapshot/
 * customerSnapshot on the parent Purchase/Sale, never a live lookup -
 * matches this app's "historical record never drifts" principle used
 * everywhere else (P&L, invoices, etc).
 *
 * 🔍 Query params: startDate, endDate (optional - all-time if both
 * omitted), branchId (SUPER_ADMIN only).
 * 👤 Role: SUPER_ADMIN sees all branches or one via branchId;
 * BRANCH_ADMIN is always forced to their own branch (route also blocks
 * STAFF - see reports.router.js, same gate as Profit & Loss).
 */

const buildDateRange = (startDate, endDate) => {
    if (!startDate && !endDate) return null;
    const range = {};
    if (startDate) {
        const s = new Date(startDate);
        s.setHours(0, 0, 0, 0);
        range.$gte = s;
    }
    if (endDate) {
        const e = new Date(endDate);
        e.setHours(23, 59, 59, 999);
        range.$lte = e;
    }
    return range;
};

// Serialized IN rows - one per physical unit, joined to its own
// Purchase for date/vendor/payment (a purchase-level total, repeated
// across every unit that purchase created - standard for a flattened
// register export). Description is this unit's own ProductSerial
// description (main line only, per the "short description" rule) -
// never Product-level, per this codebase's per-unit ownership rule.
const getInRowsSerialized = async ({ dateRange, branchMatch }) => {
    const pipeline = [
        { $match: { isDeleted: false, ...branchMatch } },
        {
            $lookup: {
                from: "purchases",
                localField: "purchaseId",
                foreignField: "_id",
                as: "purchase",
            },
        },
        { $unwind: "$purchase" },
        { $match: { "purchase.isDeleted": false } },
    ];
    if (dateRange) pipeline.push({ $match: { "purchase.purchaseDate": dateRange } });

    pipeline.push({
        $project: {
            _id: 0,
            type: { $literal: "Serialized" },
            date: "$purchase.purchaseDate",
            modelNumber: { $ifNull: ["$modelNumber", ""] },
            description: { $ifNull: ["$description.main", ""] },
            qty: { $literal: 1 },
            price: { $ifNull: ["$purchasePrice", 0] },
            paymentStatus: "$purchase.paymentStatus",
            vendorName: { $ifNull: ["$purchase.vendorSnapshot.name", ""] },
            vendorContact: { $ifNull: ["$purchase.vendorSnapshot.phone", ""] },
            // Current serial status is a real, always-set enum
            // (AVAILABLE/ASSIGNED/RESERVED/IN_TRANSIT/SOLD/DAMAGED/
            // MISSING) - passed through as-is, never blank.
            availability: "$status",
            // Row metadata only - never rendered as a spreadsheet column
            // (see buildInOutWorkbook.js), used purely so the frontend
            // can build the second, GST-applicable-only download from
            // the same fetched row set without a second API call.
            gstApplicable: { $ifNull: ["$gstApplicable", false] },
        },
    });

    return ProductSerial.aggregate(pipeline);
};

// Non-serialized IN rows - one per batch received. Model Number has no
// non-serialized equivalent anywhere in this app (it's a serialized-only
// concept), so it's always "—" via the frontend's textOr - never
// invented here. Description comes from the Product master (shared
// across every batch of that product, per Product.modal.js's own
// ownership rule for non-serialized items).
const getInRowsNonSerialized = async ({ dateRange, branchMatch }) => {
    const pipeline = [
        { $match: { ...branchMatch } },
        {
            $lookup: {
                from: "purchases",
                localField: "purchaseId",
                foreignField: "_id",
                as: "purchase",
            },
        },
        { $unwind: "$purchase" },
        { $match: { "purchase.isDeleted": false } },
    ];
    if (dateRange) pipeline.push({ $match: { "purchase.purchaseDate": dateRange } });

    pipeline.push(
        {
            $lookup: {
                from: "products",
                localField: "productId",
                foreignField: "_id",
                as: "product",
            },
        },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        {
            $project: {
                _id: 0,
                type: { $literal: "Non-Serialized" },
                date: "$purchase.purchaseDate",
                modelNumber: { $literal: "" },
                description: { $ifNull: ["$product.description", ""] },
                qty: { $ifNull: ["$quantity", 0] },
                price: { $ifNull: ["$purchasePrice", 0] },
                paymentStatus: "$purchase.paymentStatus",
                vendorName: { $ifNull: ["$purchase.vendorSnapshot.name", ""] },
                vendorContact: { $ifNull: ["$purchase.vendorSnapshot.phone", ""] },
                // Current available quantity - a real number, 0 is a
                // meaningful "fully sold out" value, never blank.
                availability: { $ifNull: ["$availableQuantity", 0] },
                // Row metadata only - never rendered as a spreadsheet
                // column (see buildInOutWorkbook.js). Non-serialized is
                // always GST-applicable per business rule (see
                // createSale.controller.js) - default true rather than
                // reading a field that may not exist on older records.
                gstApplicable: { $ifNull: ["$gstApplicable", true] },
            },
        }
    );

    return BatchStock.aggregate(pipeline);
};

// OUT rows - one per sale line item, both types together (isSerialized
// picks the branch inline rather than two separate queries, since both
// live on the exact same Sale.items array). purchaseAmount/saleAmount/
// profit are read straight off the already-frozen Sale.items fields
// (purchasePrice/finalAmount/profit), stamped once at sale time from the
// real ProductSerial/BatchStock cost - never recalculated here.
const getOutRows = async ({ dateRange, branchMatch }) => {
    const pipeline = [
        { $match: { status: "COMPLETED", isDeleted: false, ...branchMatch } },
    ];
    if (dateRange) pipeline.push({ $match: { saleDate: dateRange } });

    pipeline.push(
        { $unwind: "$items" },
        {
            $lookup: {
                from: "productserials",
                localField: "items.productSerialId",
                foreignField: "_id",
                as: "serial",
            },
        },
        {
            $lookup: {
                from: "products",
                localField: "items.productId",
                foreignField: "_id",
                as: "product",
            },
        },
        { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
        {
            $project: {
                _id: 0,
                date: "$saleDate",
                // Model Number is serialized-only (stamped from
                // ProductSerial.modelNumber at sale time) - blank on a
                // non-serialized item, which the frontend renders as "—".
                modelNumber: { $ifNull: ["$items.modelNumber", ""] },
                serialNumber: {
                    $cond: ["$items.isSerialized", { $ifNull: ["$items.serialNumber", ""] }, ""],
                },
                description: {
                    $cond: [
                        "$items.isSerialized",
                        { $ifNull: [{ $arrayElemAt: ["$serial.description.main", 0] }, ""] },
                        { $ifNull: ["$product.description", ""] },
                    ],
                },
                purchaseAmount: { $ifNull: ["$items.purchasePrice", 0] },
                // finalAmount is the real, discount/GST-inclusive line
                // total already computed and frozen at sale time - the
                // actual recorded sale amount, not the pre-adjustment
                // unit sellingPrice.
                saleAmount: { $ifNull: ["$items.finalAmount", 0] },
                customerName: { $ifNull: ["$customerSnapshot.name", ""] },
                customerContact: { $ifNull: ["$customerSnapshot.mobile", ""] },
                paymentStatus: 1,
                profit: { $ifNull: ["$items.profit", 0] },
                // Row metadata only - never rendered as a spreadsheet
                // column (see buildInOutWorkbook.js), used purely so the
                // frontend can build the second, GST-applicable-only
                // download from the same fetched row set without a
                // second API call.
                gstApplicable: { $ifNull: ["$items.gstApplicable", false] },
            },
        }
    );

    return Sale.aggregate(pipeline);
};

export const getInOutReportController = async (req, res) => {
    try {
        const user = req.user;
        const isSuperAdmin = user.role === "SUPER_ADMIN";
        const { startDate, endDate, branchId } = req.query;

        let branchObjectId = null;
        if (isSuperAdmin && branchId) {
            branchObjectId = new mongoose.Types.ObjectId(branchId);
        } else if (!isSuperAdmin) {
            if (!user.branchId) return errorResponse(res, "Branch not assigned to user", 400);
            branchObjectId = new mongoose.Types.ObjectId(user.branchId);
        }

        let branchInfo = null;
        if (branchObjectId) {
            const branch = await Branch.findById(branchObjectId).select("name code").lean();
            branchInfo = branch ? { id: branch._id, name: branch.name, code: branch.code } : null;
        }

        let branches = [];
        if (isSuperAdmin) {
            branches = await Branch.find({ isActive: true, isDeleted: false }).select("_id name code").sort({ name: 1 }).lean();
        }

        const dateRange = buildDateRange(startDate, endDate);

        // Serialized IN rows are branch-scoped by where the unit
        // currently sits (currentBranchId) - the closest thing to "did
        // this happen at my branch" for a CENTRAL purchase, which has no
        // single branchId of its own. Non-serialized IN rows and every
        // OUT row use their own direct branchId (BatchStock and Sale are
        // never CENTRAL/ambiguous).
        const serializedBranchMatch = branchObjectId ? { currentBranchId: branchObjectId } : {};
        const batchBranchMatch = branchObjectId ? { branchId: branchObjectId } : {};
        const saleBranchMatch = branchObjectId ? { branchId: branchObjectId } : {};

        const [inSerialized, inNonSerialized, outRows] = await Promise.all([
            getInRowsSerialized({ dateRange, branchMatch: serializedBranchMatch }),
            getInRowsNonSerialized({ dateRange, branchMatch: batchBranchMatch }),
            getOutRows({ dateRange, branchMatch: saleBranchMatch }),
        ]);

        const inRows = [...inSerialized, ...inNonSerialized].sort(
            (a, b) => new Date(a.date) - new Date(b.date)
        );
        outRows.sort((a, b) => new Date(a.date) - new Date(b.date));

        return successResponse(res, "IN/OUT report retrieved successfully", {
            period: { startDate: startDate || null, endDate: endDate || null },
            branch: branchInfo,
            branches,
            inRows,
            outRows,
        });
    } catch (error) {
        console.error("Get In/Out Report Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve IN/OUT report", 500);
    }
};
