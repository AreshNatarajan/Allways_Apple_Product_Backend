import Product from "../../models/Product.modal.js";
import { deriveIsSerialized } from "../../utils/deriveProductType.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const createProductController = async (req, res) => {
    try {
        const {
            name,
            category,
            productCode,
            modelNumber,
            hsnCode,
            description = "",
            isActive = true,
        } = req.body;
        // isSerialized is never trusted from the client - it's always
        // derived from category (ACCESSORY -> non-serialized, MOBILE/
        // LAPTOP/TAB -> serialized), same trust-boundary principle as
        // role/branchId never being trusted from the request body.
        // Note: images are never accepted here - they're uploaded
        // separately via POST /:id/images once the product exists, so
        // S3 keys can be tied to a real product id and never trusted
        // from client-supplied JSON.

        // ✅ Validation: Name and Category are required
        if (!name || !name.trim()) {
            return errorResponse(
                res,
                "Product name is required",
                400
            );
        }

        if (!category || !category.trim()) {
            return errorResponse(
                res,
                "Category is required",
                400
            );
        }

        // ✅ Product type is derived from category, never accepted from
        // the client.
        const isSerialized = deriveIsSerialized(category.trim());

        // ✅ HSN/SAC Code is common to both serialized and non-serialized
        // products - always required, never conditional on isSerialized.
        if (!hsnCode || !hsnCode.trim()) {
            return errorResponse(
                res,
                "HSN/SAC Code is required",
                400
            );
        }

        // ✅ Validate based on serialization
        if (isSerialized) {
            // Serialized products require exactly one Model Number
            if (!modelNumber || !modelNumber.trim()) {
                return errorResponse(
                    res,
                    "Model Number is required for serialized products",
                    400
                );
            }
        } else {
            // Non-serialized products additionally require productCode
            if (!productCode || !productCode.trim()) {
                return errorResponse(
                    res,
                    "Product Code is required for non-serialized products",
                    400
                );
            }

            // ✅ Check for existing product (only for non-serialized)
            const existingProduct = await Product.findOne({
                productCode: productCode.toUpperCase().trim(),
                isDeleted: false,
            });

            if (existingProduct) {
                return errorResponse(
                    res,
                    "Product Code already exists",
                    409
                );
            }
        }

        // ✅ Build product data
        const productData = {
            name: name.trim(),
            category: category.trim(),
            isSerialized,
            description: description.trim(),
            hsnCode: hsnCode.trim(),
            isActive: isActive !== false, // Ensures boolean
            createdBy: req.user._id,
            createdByRole: req.user.role,
        };

        // ✅ Add type-specific fields
        if (isSerialized) {
            // The schema's setter handles trim/uppercase - pass the raw value
            productData.modelNumber = modelNumber;

            // Explicitly set to undefined to avoid validation issues -
            // productCode is never used by serialized products.
            productData.productCode = undefined;
        } else {
            productData.productCode = productCode.toUpperCase().trim();

            // Explicitly clear - modelNumber is never used by non-serialized products.
            productData.modelNumber = undefined;
        }

        // ✅ Create product
        const product = await Product.create(productData);

        return successResponse(
            res,
            "Product created successfully",
            product,
            201
        );

    } catch (error) {
        console.error("Create Product Error:", error);

        // ✅ Handle Mongoose validation errors
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(err => err.message);
            return errorResponse(
                res,
                `Validation failed: ${messages.join(', ')}`,
                400
            );
        }

        // ✅ Handle duplicate key errors
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            return errorResponse(
                res,
                `${field} already exists. Please use a different value.`,
                409
            );
        }

        return errorResponse(
            res,
            error.message || "Internal server error",
            500
        );
    }
};

