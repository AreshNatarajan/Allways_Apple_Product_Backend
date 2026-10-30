import crypto from "crypto";
import mongoose from "mongoose";
import Product from "../../models/Product.modal.js";
import {
    validateImageFile,
    resolveImageExtension,
} from "../../middleware/uploadUserImage.middleware.js";
import { convertImageForStorage } from "../../services/image/convertImageForStorage.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// A product page doesn't need more than this; keeps one product from
// accumulating unbounded S3 objects.
const MAX_PRODUCT_IMAGES = 10;

// Gated by product.create OR product.edit in the router (the Create
// Product form uploads its picked images right after the product is
// created). NON-SERIALIZED products only - a serialized unit's photos
// belong to that unit (ProductSerial.images, uploaded during Purchase
// Entry), never to the shared Product.
// Accepts one or many files under the "images" field via the global
// express-fileupload middleware (no multer). Appends to images/imageKeys
// (use DELETE /:id/images to remove one). Same validation and HEIC/HEIF
// conversion as the serialized-unit staging upload
// (uploadProductSerialStagingImage.controller.js). Storage keys are
// always server-generated from the product id - the client's filename is
// never used.
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

        if (product.isSerialized) {
            return errorResponse(res, "Serialized products store photos per unit (added during Purchase Entry), not on the product", 400);
        }

        const rawFiles = req.files?.images;

        if (!rawFiles) {
            return errorResponse(res, "No image file(s) uploaded", 400);
        }

        const files = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

        if ((product.images?.length || 0) + files.length > MAX_PRODUCT_IMAGES) {
            return errorResponse(res, `A product can have at most ${MAX_PRODUCT_IMAGES} images`, 400);
        }

        for (const file of files) {
            const validationError = validateImageFile(file);
            if (validationError) {
                return errorResponse(res, validationError, 400);
            }
        }

        let converted;
        try {
            converted = await Promise.all(files.map((file) => convertImageForStorage(file, resolveImageExtension(file))));
        } catch (conversionError) {
            console.error("Product image conversion error:", conversionError);
            return errorResponse(res, "Could not process one of these images - the file may be corrupted", 400);
        }

        const uploaded = [];
        for (const { data, mimetype, extension } of converted) {
            const storageKey = `products/${id}/${Date.now()}-${crypto
                .randomBytes(6)
                .toString("hex")}.${extension}`;

            const { url, key } = await putObject(data, storageKey, mimetype);
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
