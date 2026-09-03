// controllers/inventory/getSerializedInventory.controller.js
import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Product from "../../models/Product.modal.js";
import Purchase from "../../models/Purchase.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { canViewInventoryCost } from "../../utils/stripInventoryCostFields.js";
import { resolveInventoryBranchScope } from "../../utils/resolveInventoryBranchScope.js";
import paginate from "../../utils/pagination.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// purchaseDate lives on the populated Purchase document, not on
// ProductSerial itself - sorting by a joined field at the Mongo level
// would require an aggregation pipeline, so it's approximated here by
// ProductSerial.createdAt (the unit is created at receive time, which
// tracks purchaseDate closely in practice). sellingPrice/purchasePrice/
// serialNumber/status are real direct-field sorts.
const SORTABLE_FIELDS = {
    purchaseDate: "createdAt",
    sellingPrice: "sellingPrice",
    purchasePrice: "purchasePrice",
    serialNumber: "serialNumber",
    status: "status",
};

// productName/vendorName/modelNumber are populated/joined fields
// (productId.name, purchaseId.vendorId.name, productId.modelNumber - the
// latter no longer lives on ProductSerial at all, always the product
// master) - a plain Mongo .sort() can't reach them, so these are sorted
// in-memory over the full filtered+populated set, mirroring the
// CUSTOM_SORT_FIELDS pattern already used in
// getAllPurchases.controller.js/getAllSales.controller.js.
const IN_MEMORY_SORT_FIELDS = new Set(["productName", "vendorName", "modelNumber"]);

export const getSerializedInventoryController = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { search = "", status = "", branchId, category, vendorId, modelNumber, startDate, endDate, sortBy, sortOrder } = req.query;
        const user = req.user;
        const canViewCost = canViewInventoryCost(user.role);

        const branchScope = await resolveInventoryBranchScope(user, branchId);
        if (branchScope.error) {
            return errorResponse(res, branchScope.error, 400);
        }
        if (branchScope.noBranch) {
            return successResponse(res, "Serialized inventory retrieved successfully", {
                inventory: [],
                pagination: { total: 0, page: parseInt(page) || 1, limit: parseInt(limit) || 10, totalPages: 1 },
                filters: { search: "", status: "ALL", category: "ALL", branchId: "ALL" },
            });
        }
        const scopedBranchId = branchScope.scopedBranchId;

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

        // ---- vendor / date-range / modelNumber click-to-filter: none of
        // these live on ProductSerial directly (modelNumber always comes
        // from the product master now; vendor/date live on the populated
        // Purchase doc), so all resolve to an id-list first, same
        // two-step pattern already used above for category ----
        const purchaseIdConstraints = [];
        if (vendorId && vendorId !== "ALL" && mongoose.Types.ObjectId.isValid(vendorId)) {
            const vendorPurchases = await Purchase.find({ vendorId }).select("_id").lean();
            purchaseIdConstraints.push({ purchaseId: { $in: vendorPurchases.map((p) => p._id) } });
        }
        if (startDate || endDate) {
            const dateRange = {};
            if (startDate) dateRange.$gte = new Date(`${startDate}T00:00:00.000Z`);
            if (endDate) dateRange.$lte = new Date(`${endDate}T23:59:59.999Z`);
            const datedPurchases = await Purchase.find({ purchaseDate: dateRange }).select("_id").lean();
            purchaseIdConstraints.push({ purchaseId: { $in: datedPurchases.map((p) => p._id) } });
        }

        const andClauses = [];
        if (filter.$or) {
            andClauses.push({ $or: filter.$or });
            delete filter.$or;
        }
        andClauses.push(...purchaseIdConstraints);

        if (modelNumber && modelNumber.trim() !== "") {
            const modelProducts = await Product.find({ modelNumber: modelNumber.trim() }).select("_id").lean();
            andClauses.push({ productId: { $in: modelProducts.map((p) => p._id) } });
        }

        if (search && search.trim() !== "" && search !== "undefined") {
            const searchTerm = search.trim();
            const searchRegex = new RegExp(escapeRegex(searchTerm), "i");
            const matchingProducts = await Product.find({
                $or: [{ name: searchRegex }, { modelNumber: searchRegex }],
            }).select("_id").lean();

            const searchOr = [
                { serialNumber: searchRegex },
            ];
            if (matchingProducts.length > 0) {
                searchOr.push({ productId: { $in: matchingProducts.map((p) => p._id) } });
            }
            andClauses.push({ $or: searchOr });
        }

        if (andClauses.length > 0) filter.$and = andClauses;

        // Non-SUPER_ADMIN never sorts by purchasePrice - that column
        // doesn't even render for them, so fall back to the default
        // rather than trusting a client-sent sortBy for a field they
        // can't see (defense in depth, matches the never-trust-client
        // convention used elsewhere for role/branchId).
        const effectiveSortBy = sortBy === "purchasePrice" && !canViewCost ? "" : sortBy;

        const mapRow = (item) => {
            const row = {
                _id: item._id,
                productId: item.productId?._id || null,
                productName: item.productId?.name || "Unknown Product",
                category: item.productId?.category || "",
                modelNumber: item.productId?.modelNumber || "",
                serialNumber: item.serialNumber,
                vendorId: item.purchaseId?.vendorId?._id || null,
                // Snapshot-first (matches PurchaseRow.jsx/VendorDetailsCard.jsx's
                // own explicit convention) - a purchase's vendor display
                // must reflect who it was actually from at that time, not
                // silently follow a later edit to the live Vendor
                // document. This also makes Type 2 Exchange trade-in
                // stock correctly show the customer's name (stamped into
                // vendorSnapshot.name, see tradeInProcessor.service.js)
                // instead of the shared system vendor's own generic name.
                vendorName: item.purchaseId?.vendorSnapshot?.name || item.purchaseId?.vendorId?.name || "-",
                sellingPrice: item.sellingPrice || 0,
                gstApplicable: !!item.gstApplicable,
                status: item.status,
                purchaseDate: item.purchaseId?.purchaseDate || item.createdAt,
                purchaseNumber: item.purchaseId?.purchaseNumber || "-",
            };
            if (canViewCost) row.purchasePrice = item.purchasePrice || 0;
            return row;
        };

        let inventory;
        let total;

        if (IN_MEMORY_SORT_FIELDS.has(effectiveSortBy)) {
            const allRows = await ProductSerial.find(filter)
                .populate("productId", "name category productCode modelNumber")
                .populate({
                    path: "purchaseId",
                    select: "purchaseNumber purchaseDate vendorId vendorSnapshot",
                    populate: { path: "vendorId", select: "name" },
                })
                .lean();

            const mapped = allRows.map(mapRow);
            const sortDir = sortOrder === "asc" ? 1 : -1;
            mapped.sort((a, b) => {
                const av = (a[effectiveSortBy] || "").toString().toUpperCase();
                const bv = (b[effectiveSortBy] || "").toString().toUpperCase();
                if (av < bv) return -1 * sortDir;
                if (av > bv) return 1 * sortDir;
                return 0;
            });

            total = mapped.length;
            inventory = mapped.slice(skip, skip + limit);
        } else {
            const sortField = SORTABLE_FIELDS[effectiveSortBy] || "createdAt";
            const sortDir = sortOrder === "asc" ? 1 : -1;

            const [rows, count] = await Promise.all([
                ProductSerial.find(filter)
                    .populate("productId", "name category productCode modelNumber")
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

            inventory = rows.map(mapRow);
            total = count;
        }

        const totalPages = Math.max(1, Math.ceil(total / limit));

        return successResponse(res, "Serialized inventory retrieved successfully", {
            inventory,
            pagination: { total, page: parseInt(page), limit: parseInt(limit), totalPages },
            filters: {
                search: search || "", status: status || "ALL", category: category || "ALL",
                branchId: branchId || "ALL", vendorId: vendorId || "ALL", modelNumber: modelNumber || "",
                startDate: startDate || "", endDate: endDate || "",
                sortBy: sortBy || "", sortOrder: sortOrder || "desc",
            },
        });
    } catch (error) {
        console.error("Get Serialized Inventory Error:", error);
        return errorResponse(res, "Failed to retrieve serialized inventory", 500);
    }
};
