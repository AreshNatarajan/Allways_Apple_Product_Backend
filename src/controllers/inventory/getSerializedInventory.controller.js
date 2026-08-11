// controllers/inventory/getSerializedInventory.controller.js
import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Product from "../../models/Product.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import paginate from "../../utils/pagination.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// purchaseDate lives on the populated Purchase document, not on
// ProductSerial itself - sorting by a joined field at the Mongo level
// would require an aggregation pipeline, so it's approximated here by
// ProductSerial.createdAt (the unit is created at receive time, which
// tracks purchaseDate closely in practice). sellingPrice/purchasePrice/
// serialNumber are real direct-field sorts.
const SORTABLE_FIELDS = {
    purchaseDate: "createdAt",
    sellingPrice: "sellingPrice",
    purchasePrice: "purchasePrice",
    serialNumber: "serialNumber",
};

// Inventory is the master stock history screen - SOLD/DAMAGED serials
// are never excluded by default, only filterable via `status`. Branch
// scoping is inline (SUPER_ADMIN optional filter, everyone else forced
// to their own branch) rather than the shared getBranchFilter
// middleware, which leaves STAFF unscoped.
export const getSerializedInventoryController = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { search = "", status = "", branchId, category, sortBy, sortOrder } = req.query;
        const user = req.user;

        let scopedBranchId = null;
        if (user.role === "SUPER_ADMIN") {
            if (branchId && branchId !== "ALL" && mongoose.Types.ObjectId.isValid(branchId)) {
                scopedBranchId = branchId;
            }
        } else {
            if (!user.branchId) {
                return successResponse(res, "Serialized inventory retrieved successfully", {
                    inventory: [],
                    pagination: { total: 0, page: parseInt(page) || 1, limit: parseInt(limit) || 10, totalPages: 1 },
                    filters: { search: "", status: "ALL", category: "ALL", branchId: "ALL" },
                });
            }
            scopedBranchId = user.branchId;
        }

        const filter = { isDeleted: false };

        if (scopedBranchId) {
            filter.$or = [
                { currentBranchId: scopedBranchId },
                { assignedBranchId: scopedBranchId, status: "IN_TRANSIT" },
            ];
        }

        if (status && status !== "ALL") {
            filter.status = status;
        }

        if (category && category !== "ALL") {
            const categoryProducts = await Product.find({ category }).select("_id").lean();
            filter.productId = { $in: categoryProducts.map((p) => p._id) };
        }

        if (search && search.trim() !== "" && search !== "undefined") {
            const searchTerm = search.trim();
            const searchRegex = new RegExp(escapeRegex(searchTerm), "i");
            const matchingProducts = await Product.find({ name: searchRegex }).select("_id").lean();

            const searchOr = [
                { serialNumber: searchRegex },
                { modelNumber: searchRegex },
            ];
            if (matchingProducts.length > 0) {
                searchOr.push({ productId: { $in: matchingProducts.map((p) => p._id) } });
            }

            if (filter.$or) {
                filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
                delete filter.$or;
            } else {
                filter.$or = searchOr;
            }
        }

        const sortField = SORTABLE_FIELDS[sortBy] || "createdAt";
        const sortDir = sortOrder === "asc" ? 1 : -1;

        const [rows, total] = await Promise.all([
            ProductSerial.find(filter)
                .populate("productId", "name category productCode")
                .populate({
                    path: "purchaseId",
                    select: "purchaseNumber purchaseDate vendorId vendorSnapshot",
                    populate: { path: "vendorId", select: "name" },
                })
                .sort({ [sortField]: sortDir })
                .skip(skip)
                .limit(limit)
                .lean(),
            ProductSerial.countDocuments(filter),
        ]);

        // Purchase/selling price come straight from ProductSerial's own
        // fields - each physical unit is priced independently and must
        // never be re-derived from Purchase.items[] (which is shared
        // across every serial on that purchase line and would
        // misattribute price when a line has more than one serial).
        const inventory = rows.map((item) => ({
            _id: item._id,
            productId: item.productId?._id || null,
            productName: item.productId?.name || "Unknown Product",
            category: item.productId?.category || "",
            modelNumber: item.modelNumber || "",
            serialNumber: item.serialNumber,
            vendorName: item.purchaseId?.vendorId?.name || item.purchaseId?.vendorSnapshot?.name || "-",
            purchasePrice: item.purchasePrice || 0,
            sellingPrice: item.sellingPrice || 0,
            gstApplicable: !!item.gstApplicable,
            status: item.status,
            purchaseDate: item.purchaseId?.purchaseDate || item.createdAt,
            purchaseNumber: item.purchaseId?.purchaseNumber || "-",
        }));

        const totalPages = Math.max(1, Math.ceil(total / limit));

        return successResponse(res, "Serialized inventory retrieved successfully", {
            inventory,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages,
            },
            filters: {
                search: search || "",
                status: status || "ALL",
                category: category || "ALL",
                branchId: branchId || "ALL",
                sortBy: sortBy || "",
                sortOrder: sortOrder || "desc",
            },
        });
    } catch (error) {
        console.error("Get Serialized Inventory Error:", error);
        return errorResponse(res, "Failed to retrieve serialized inventory", 500);
    }
};
