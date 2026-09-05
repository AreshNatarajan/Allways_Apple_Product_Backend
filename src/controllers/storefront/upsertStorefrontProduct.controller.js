import mongoose from "mongoose";
import StorefrontProduct from "../../models/StorefrontProduct.modal.js";
import Product from "../../models/Product.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// One StorefrontProduct row per Product (unique productId) - this
// single endpoint both creates the listing the first time a product is
// added to the online catalog, and updates it every time after (price/
// description/images/featured/isListed), keyed by :productId rather
// than the listing's own _id, since staff always start from "which
// Product am I curating", never from the listing document itself.
export const upsertStorefrontProductController = async (req, res) => {
    try {
        const { productId } = req.params;
        const { displayPrice, shortDescription, description, images, featured, isListed, sortOrder } = req.body;

        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return errorResponse(res, "Invalid product ID", 400);
        }

        const product = await Product.findOne({ _id: productId, isDeleted: false });
        if (!product) {
            return errorResponse(res, "Product not found", 404);
        }

        const priceValue = Number(displayPrice);
        if (isListed && (!priceValue || priceValue <= 0)) {
            return errorResponse(res, "A valid display price is required to list this product", 400);
        }

        const user = req.user;
        const update = {
            displayPrice: priceValue || 0,
            shortDescription: shortDescription || "",
            description: description || "",
            images: Array.isArray(images) ? images : [],
            featured: !!featured,
            isListed: !!isListed,
            sortOrder: Number(sortOrder) || 0,
            updatedBy: user._id,
        };

        const listing = await StorefrontProduct.findOneAndUpdate(
            { productId, isDeleted: false },
            { $set: update, $setOnInsert: { productId, createdBy: user._id } },
            { new: true, upsert: true, runValidators: true }
        ).populate("productId", "name category modelNumber productCode isSerialized");

        return successResponse(res, "Storefront listing saved successfully", { listing });
    } catch (error) {
        console.error("Upsert Storefront Product Error:", error);
        return errorResponse(res, "Failed to save storefront listing", 500);
    }
};
