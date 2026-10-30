import mongoose from "mongoose";
import Product from "../../models/Product.modal.js";
import { deleteObject } from "../fileUpload/Products/deleteObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Gated by product.edit in the router. Removes exactly one image,
// identified by its S3 key (returned from the upload endpoint) rather
// than by array index or URL, since the key is the one value guaranteed
// unique per image. The DB arrays are the source of truth: the image is
// removed from images/imageKeys even if the S3 delete fails (or is
// skipped - see deleteObject.js's quarantine switch), and that is only
// logged - same best-effort cleanup as branch logo / profile image.
export const removeProductImageController = async (req, res) => {
    try {
        const { id } = req.params;
        const { key } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid product ID", 400);
        }

        if (!key) {
            return errorResponse(res, "Image key is required", 400);
        }

        const product = await Product.findOne({ _id: id, isDeleted: false });

        if (!product) {
            return errorResponse(res, "Product not found", 404);
        }

        const keyIndex = product.imageKeys.indexOf(key);

        if (keyIndex === -1) {
            return errorResponse(res, "Image not found on this product", 404);
        }

        product.images.splice(keyIndex, 1);
        product.imageKeys.splice(keyIndex, 1);
        product.updatedBy = req.user._id;
        product.updatedByRole = req.user.role;

        await product.save();

        try {
            await deleteObject(key);
        } catch (cleanupError) {
            console.error("Product image S3 cleanup failed:", cleanupError);
        }

        return successResponse(
            res,
            "Product image removed successfully",
            { images: product.images, imageKeys: product.imageKeys }
        );
    } catch (error) {
        console.error("Remove Product Image Error:", error);
        return errorResponse(res, "Server error while removing product image", 500);
    }
};
