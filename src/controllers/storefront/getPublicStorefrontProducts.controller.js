import ProductSerial from "../../models/ProductSerial.modal.js";
import Product from "../../models/Product.modal.js";
import paginate from "../../utils/pagination.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "Air  M5" -> ["Air", "M5"]. Capped so a pasted paragraph can't turn
// into dozens of queries.
const MAX_SEARCH_WORDS = 6;
const searchWords = (search) =>
    typeof search === "string" ? search.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS) : [];

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

        // iCloud units are never shown on the public storefront ($ne keeps
        // older units with no icloud value visible).
        const filter = { isDeleted: false, status: "AVAILABLE", icloud: { $ne: true } };

        if (branchId?.trim() && branchId !== "ALL") {
            filter.currentBranchId = branchId.trim();
        }
        if (minPrice || maxPrice) {
            filter.sellingPrice = {};
            if (minPrice) filter.sellingPrice.$gte = Number(minPrice);
            if (maxPrice) filter.sellingPrice.$lte = Number(maxPrice);
        }

        if (category?.trim()) {
            const matches = await Product.find({ category: category.trim().toUpperCase() }).select("_id").lean();
            filter.productId = { $in: matches.map((p) => p._id) };
        }

        // Word-by-word search across the product's name / model number AND
        // this unit's own main description ("MACBOOK PRO M3/18GB/512GB 14\"").
        // Every word typed must appear somewhere, in any order and in
        // either place - so "air m5" finds a MacBook Air whose description
        // says M5, and "pro 14" finds "MACBOOK PRO 14\"-A2992".
        const words = searchWords(search);
        if (words.length > 0) {
            const clauses = await Promise.all(
                words.map(async (word) => {
                    const pattern = new RegExp(escapeRegex(word), "i");
                    const named = await Product.find({ $or: [{ name: pattern }, { modelNumber: pattern }] }).select("_id").lean();
                    return { $or: [{ productId: { $in: named.map((p) => p._id) } }, { "description.main": pattern }] };
                })
            );
            filter.$and = clauses;
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
            .map((s) => {
                // Staff sets `position` manually at Purchase Create/Edit
                // time (see SerialImageModal.jsx) - sorted here rather
                // than trusted as already-sorted, so the grid thumbnail
                // (images[0]) is always the genuine position-1 photo even
                // for a record saved before this field existed.
                const sortedImages = [...(s.images || [])].sort((a, b) => (a.position || 0) - (b.position || 0));
                return {
                    _id: s._id,
                    name: s.productId.name,
                    category: s.productId.category,
                    modelNumber: s.productId.modelNumber || "",
                    price: s.sellingPrice || 0,
                    shortDescription: s.description?.main || "",
                    image: sortedImages[0]?.url || null,
                    images: sortedImages,
                    branch: s.currentBranchId ? { _id: s.currentBranchId._id, name: s.currentBranchId.name, code: s.currentBranchId.code } : null,
                };
            });

        return successResponse(res, "Products retrieved successfully", {
            products,
            pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
        });
    } catch (error) {
        console.error("Get Public Storefront Products Error:", error);
        return errorResponse(res, "Failed to retrieve products", 500);
    }
};
