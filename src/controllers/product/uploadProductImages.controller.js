import crypto from "crypto";
import mongoose from "mongoose";
import Product from "../../models/Product.modal.js";
import {
    validateImageFile,
    MIME_TO_EXTENSION,
} from "../../middleware/uploadUserImage.middleware.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// SUPER_ADMIN / BRANCH_ADMIN only (see onlyAdminRoles in the router).
// Accepts one or many files under the "images" field via the global
// express-fileupload middleware (no multer - see uploadUserImage
// middleware.js for why). Appends to the product's images/imageKeys
// arrays rather than replacing them; use DELETE /:id/images to remove
// a single image. Storage keys are always server-generated from the
// product id + timestamp + random bytes + a mimetype-derived
// extension - the client's original filename is never used.
export const uploadProductImagesController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid product ID", 400);
        }

        const product = await Product.findOne({ _id: id, isDeleted: false });

        if (!product) {
            return errorResponse(res, "Product not found", 404);
        }

        const rawFiles = req.files?.images;

        if (!rawFiles) {
            return errorResponse(res, "No image file(s) uploaded", 400);
        }

        const files = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

        for (const file of files) {
            const validationError = validateImageFile(file);
            if (validationError) {
                return errorResponse(res, validationError, 400);
            }
        }

        const uploaded = [];
        for (const file of files) {
            const extension = MIME_TO_EXTENSION[file.mimetype] || "jpg";
            const storageKey = `products/${id}/${Date.now()}-${crypto
                .randomBytes(6)
                .toString("hex")}.${extension}`;

            const { url, key } = await putObject(file.data, storageKey, file.mimetype);
            uploaded.push({ url, key });
        }

        product.images.push(...uploaded.map((u) => u.url));
        product.imageKeys.push(...uploaded.map((u) => u.key));
        product.updatedBy = req.user._id;
        product.updatedByRole = req.user.role;

        await product.save();

        return successResponse(
            res,
            "Product image(s) uploaded successfully",
            { images: product.images, imageKeys: product.imageKeys },
            201
        );
    } catch (error) {
        console.error("Upload Product Images Error:", error);
        return errorResponse(res, "Server error while uploading product image(s)", 500);
    }
};
