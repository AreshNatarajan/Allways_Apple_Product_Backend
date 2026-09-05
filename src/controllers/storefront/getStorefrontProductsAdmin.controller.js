import StorefrontProduct from "../../models/StorefrontProduct.modal.js";
import Product from "../../models/Product.modal.js";
import paginate from "../../utils/pagination.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Staff-side "Online Catalog" list - every curated listing regardless
// of isListed, so staff can see what's live vs. still in draft. Search
// matches the linked Product's own name/modelNumber (StorefrontProduct
// itself has no name field - it's never duplicated off Product).
export const getStorefrontProductsAdminController = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { search, isListed } = req.query;

        const filter = { isDeleted: false };
        if (isListed === "true") filter.isListed = true;
        else if (isListed === "false") filter.isListed = false;

        if (search?.trim()) {
            const term = search.trim();
            const matches = await Product.find({
                $or: [
                    { name: { $regex: term, $options: "i" } },
                    { modelNumber: { $regex: term, $options: "i" } },
                ],
            }).select("_id").lean();
            filter.productId = { $in: matches.map((p) => p._id) };
        }

        const [listings, total] = await Promise.all([
            StorefrontProduct.find(filter)
                .populate("productId", "name category modelNumber productCode isSerialized")
                .populate("createdBy", "name email")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
            StorefrontProduct.countDocuments(filter),
        ]);

        return successResponse(res, "Storefront listings retrieved successfully", {
            listings,
            pagination: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
        });
    } catch (error) {
        console.error("Get Storefront Products Admin Error:", error);
        return errorResponse(res, "Failed to retrieve storefront listings", 500);
    }
};
