// controllers/reports/getInOutReport.controller.js
import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Sale from "../../models/Sale.modal.js";
import Branch from "../../models/Branch.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

/**
 * 📋 IN / OUT REGISTER REPORT
 *
 * Returns every row needed to build both Excel reports the frontend
 * generates client-side (GST-applicable-only, and the overall
 * register) - one backend call, since every row already carries its own
 * `gstApplicable` flag, the frontend just filters the same data twice
 * rather than this endpoint being queried twice.
 *
 * IN = one row per physical unit received (ProductSerial, serialized)
 * or per batch received (BatchStock, non-serialized), joined back to
 * the Purchase that created it for date/dealer/payment info.
 * OUT = one row per sale line item (Sale.items, both types), joined to
 * ProductSerial for a serialized item's own notes (never Product-level
 * - see ProductSerial.modal.js's ownership rule).
 *
 * Dealer/customer identity uses the frozen vendorSnapshot/
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
// Purchase for date/dealer/payment (a purchase-level total, repeated
// across every unit that purchase created - standard for a flattened
// register export).
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
            productCode: { $literal: "" },
            serialOrBatch: "$serialNumber",
            qty: { $literal: 1 },
            price: { $ifNull: ["$purchasePrice", 0] },
            paidAmount: { $ifNull: ["$purchase.paidAmount", 0] },
            pendingAmount: { $ifNull: ["$purchase.pendingAmount", 0] },
            paymentStatus: "$purchase.paymentStatus",
            partyName: { $ifNull: ["$purchase.vendorSnapshot.name", ""] },
            partyMobile: { $ifNull: ["$purchase.vendorSnapshot.phone", ""] },
            remarks: { $ifNull: ["$notes", ""] },
            status: 1,
            gstApplicable: { $ifNull: ["$gstApplicable", false] },
        },
    });

    return ProductSerial.aggregate(pipeline);
};

// Non-serialized IN rows - one per batch received. remarks stays blank
// (no per-batch notes equivalent).
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

    pipeline.push({
        $project: {
            _id: 0,
            type: { $literal: "Non-Serialized" },
            date: "$purchase.purchaseDate",
            modelNumber: { $literal: "" },
            productCode: { $ifNull: ["$productCode", ""] },
            serialOrBatch: "$batchNumber",
            qty: { $ifNull: ["$quantity", 0] },
            price: { $ifNull: ["$purchasePrice", 0] },
            paidAmount: { $ifNull: ["$purchase.paidAmount", 0] },
            pendingAmount: { $ifNull: ["$purchase.pendingAmount", 0] },
            paymentStatus: "$purchase.paymentStatus",
            partyName: { $ifNull: ["$purchase.vendorSnapshot.name", ""] },
            partyMobile: { $ifNull: ["$purchase.vendorSnapshot.phone", ""] },
            remarks: { $literal: "" },
            status: 1,
            // Non-serialized is always GST-applicable per business rule
            // (see createSale.controller.js) - default true rather than
            // reading a field that may not exist on older records.
            gstApplicable: { $ifNull: ["$gstApplicable", true] },
        },
    });

    return BatchStock.aggregate(pipeline);
};

// OUT rows - one per sale line item, both types together (isSerialized
// picks the branch inline rather than two separate queries, since both
// live on the exact same Sale.items array).
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
            $project: {
                _id: 0,
                type: { $cond: ["$items.isSerialized", "Serialized", "Non-Serialized"] },
                date: "$saleDate",
                modelNumber: { $cond: ["$items.isSerialized", { $ifNull: ["$items.modelNumber", ""] }, ""] },
                productCode: { $cond: ["$items.isSerialized", "", { $ifNull: ["$items.productCode", ""] }] },
                serialOrBatch: { $cond: ["$items.isSerialized", "$items.serialNumber", "$items.batchNumber"] },
                purchasePrice: { $ifNull: ["$items.purchasePrice", 0] },
                salePrice: { $ifNull: ["$items.sellingPrice", 0] },
                partyName: { $ifNull: ["$customerSnapshot.name", ""] },
                partyMobile: { $ifNull: ["$customerSnapshot.mobile", ""] },
                paidAmount: { $ifNull: ["$paidAmount", 0] },
                pendingAmount: { $ifNull: ["$pendingAmount", 0] },
                paymentStatus: 1,
                remarks: { $ifNull: [{ $arrayElemAt: ["$serial.notes", 0] }, ""] },
                profit: { $ifNull: ["$items.profit", 0] },
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
