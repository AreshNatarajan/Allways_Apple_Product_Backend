import ProductSerial from "../../models/ProductSerial.modal.js";
import Product from "../../models/Product.modal.js";
import paginate from "../../utils/pagination.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const SORTABLE = {
    newest: { receivedAt: -1, createdAt: -1 },
    priceLow: { sellingPrice: 1 },
    priceHigh: { sellingPrice: -1 },
};

// PUBLIC, unauthenticated - the storefront's product listing, sourced
// straight from REAL branch inventory (ProductSerial, status:AVAILABLE)
// across every branch, not a separate curated catalog - this
// deliberately replaces the earlier StorefrontProduct-backed version
// (that model/its admin page are left in place, just no longer wired to
// this public read path - see StorefrontProduct.modal.js). One physical
// unit = one listing here, same as everywhere else this app treats a
// serialized product - each carries its own price/condition/photos, so
// there's nothing to separately curate. Non-serialized (batch) stock is
// deliberately never listed here (per this feature's own scope), and
// NEVER exposes purchasePrice/GST/vendor - only what's already safe to
// show a customer.
export const getPublicStorefrontProductsController = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { search, category, branchId, minPrice, maxPrice, sort } = req.query;

        const filter = { isDeleted: false, status: "AVAILABLE" };

        if (branchId?.trim() && branchId !== "ALL") {
            filter.currentBranchId = branchId.trim();
        }
        if (minPrice || maxPrice) {
            filter.sellingPrice = {};
            if (minPrice) filter.sellingPrice.$gte = Number(minPrice);
            if (maxPrice) filter.sellingPrice.$lte = Number(maxPrice);
        }

        if (category?.trim() || search?.trim()) {
            const productFilter = {};
            if (category?.trim()) productFilter.category = category.trim().toUpperCase();
            if (search?.trim()) {
                const term = search.trim();
                productFilter.$or = [
                    { name: { $regex: term, $options: "i" } },
                    { modelNumber: { $regex: term, $options: "i" } },
                ];
            }
            const matches = await Product.find(productFilter).select("_id").lean();
            filter.productId = { $in: matches.map((p) => p._id) };
        }

        const sortSpec = SORTABLE[sort] || SORTABLE.newest;

        const [serials, total] = await Promise.all([
            ProductSerial.find(filter)
                .populate("productId", "name category modelNumber")
                .populate("currentBranchId", "name code")
                .select("productId currentBranchId sellingPrice description images mdm createdAt receivedAt")
                .sort(sortSpec)
                .skip(skip)
                .limit(limit)
                .lean(),
            ProductSerial.countDocuments(filter),
        ]);

        const products = serials
            .filter((s) => s.productId)
            .map((s) => ({
                _id: s._id,
                name: s.productId.name,
                category: s.productId.category,
                modelNumber: s.productId.modelNumber || "",
                price: s.sellingPrice || 0,
                shortDescription: s.description?.main || "",
                image: s.images?.[0]?.url || null,
                images: s.images || [],
                branch: s.currentBranchId ? { _id: s.currentBranchId._id, name: s.currentBranchId.name, code: s.currentBranchId.code } : null,
            }));

        return successResponse(res, "Products retrieved successfully", {
            products,
            pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
        });
    } catch (error) {
        console.error("Get Public Storefront Products Error:", error);
        return errorResponse(res, "Failed to retrieve products", 500);
    }
};
