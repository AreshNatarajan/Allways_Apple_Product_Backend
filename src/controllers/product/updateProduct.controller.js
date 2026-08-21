import mongoose from "mongoose";
import Product from "../../models/Product.modal.js";
import Batch from "../../models/Batch.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Inventory from "../../models/Inventory.modal.js";
import { deriveIsSerialized } from "../../utils/deriveProductType.js";
import { buildLaptopProductName, validateLaptopNameParts } from "../../utils/buildLaptopProductName.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const updateProductController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return errorResponse(res, "Product ID is required", 400);
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid product ID", 400);
        }

        const {
            name,
            category,
            description,
            isActive,
            productCode,
            hsnCode,
            modelNumber,
            nameParts,
        } = req.body;
        // Note: images/imageKeys are never accepted here - they're only
        // ever changed via POST/DELETE /:id/images. isSerialized is
        // never accepted from the client either - it's always derived
        // from the (possibly-updated) category below.

        const product = await Product.findOne({
            _id: id,
            isDeleted: false,
        });

        if (!product) {
            return errorResponse(res, "Product not found", 404);
        }

        // ✅ Resolve the effective category for this update (may be
        // unchanged) and derive isSerialized from it, so conditional
        // validation below always reflects the product's state *after*
        // this update is applied.
        const nextCategory = category !== undefined ? category : product.category;
        const nextIsSerialized = deriveIsSerialized(nextCategory);
        const isLaptopNext = nextCategory === "LAPTOP";

        // ✅ If serialization type is actually changing, refuse the
        // change when any downstream Batch/BatchStock/ProductSerial/
        // Inventory record already references this product - those
        // modules are out of scope for this phase, and silently
        // allowing the flip would leave them holding data for a product
        // type that no longer matches (e.g. quantity-based BatchStock
        // rows for a product that's now serialized, or ProductSerial
        // rows for a product that's now non-serialized). This is a
        // read-only existence check; nothing in those collections is
        // modified.
        if (nextIsSerialized !== product.isSerialized) {
            const [
                batchExists,
                batchStockExists,
                serialExists,
                inventoryExists,
            ] = await Promise.all([
                Batch.exists({ productId: product._id }),
                BatchStock.exists({ productId: product._id }),
                ProductSerial.exists({ productId: product._id }),
                Inventory.exists({ productId: product._id }),
            ]);

            if (batchExists || batchStockExists || serialExists || inventoryExists) {
                return errorResponse(
                    res,
                    "Cannot change serialization type: this product already has Batch, Inventory, or Serial records that depend on its current type. Deactivate this product and create a new one instead.",
                    409
                );
            }
        }

        // ✅ HSN/SAC Code is common to both serialized and non-serialized
        // products - always required, never conditional on isSerialized.
        const nextHsnCode =
            hsnCode !== undefined ? hsnCode : product.hsnCode;

        if (!nextHsnCode || !String(nextHsnCode).trim()) {
            return errorResponse(
                res,
                "HSN/SAC Code is required",
                400
            );
        }

        // ✅ Validate conditional fields for the effective post-update state
        if (nextIsSerialized) {
            const nextModelNumber =
                modelNumber !== undefined ? modelNumber : product.modelNumber;

            if (!nextModelNumber || !String(nextModelNumber).trim()) {
                return errorResponse(
                    res,
                    "Model Number is required for serialized products",
                    400
                );
            }
        } else {
            const nextProductCode =
                productCode !== undefined ? productCode : product.productCode;

            if (!nextProductCode || !String(nextProductCode).trim()) {
                return errorResponse(
                    res,
                    "Product Code is required for non-serialized products",
                    400
                );
            }

            // ✅ Check duplicate product code (only relevant once non-serialized)
            const normalizedCode = String(nextProductCode).toUpperCase().trim();
            if (normalizedCode !== product.productCode) {
                const existingProduct = await Product.findOne({
                    _id: { $ne: id },
                    productCode: normalizedCode,
                    isDeleted: false,
                });

                if (existingProduct) {
                    return errorResponse(res, "Product Code already exists", 409);
                }
            }
        }

        // ✅ LAPTOP - structured name correction, opt-in only. A raw
        // client-sent `name` is ignored entirely for LAPTOP (same
        // trust-boundary reasoning as create) - `name` is only ever
        // settable through nameParts. If nameParts wasn't sent at all
        // (the admin didn't touch the structured fields - e.g. only
        // toggled isActive or edited the description), `name`/
        // `nameParts` are left completely untouched - this is the
        // literal "do not automatically overwrite or destroy the
        // existing value" requirement for legacy/free-text names.
        let generatedName = null;
        const hasNameParts = nameParts && (nameParts.productName || nameParts.series || nameParts.screenSizes);
        if (isLaptopNext && hasNameParts) {
            const nextModelNumberForName = modelNumber !== undefined ? modelNumber : product.modelNumber;
            const validationError = validateLaptopNameParts({ ...nameParts, modelNumber: nextModelNumberForName });
            if (validationError) {
                return errorResponse(res, validationError, 400);
            }

            generatedName = buildLaptopProductName({ ...nameParts, modelNumber: nextModelNumberForName });

            const existingLaptop = await Product.findOne({
                _id: { $ne: id },
                name: generatedName,
                category: "LAPTOP",
                isDeleted: false,
            });
            if (existingLaptop) {
                return errorResponse(res, `A product named "${generatedName}" already exists`, 409);
            }
        }

        // ✅ Apply updates
        if (isLaptopNext) {
            if (generatedName) {
                product.name = generatedName;
                product.nameParts = {
                    productName: nameParts.productName,
                    series: nameParts.series,
                    screenSizes: nameParts.screenSizes,
                };
            }
            // else: nameParts wasn't sent - name/nameParts stay exactly as they are.
        } else if (name !== undefined) {
            product.name = name.trim();
        }
        if (category !== undefined) product.category = category;
        product.isSerialized = nextIsSerialized;
        if (description !== undefined) product.description = description;
        if (typeof isActive === "boolean") product.isActive = isActive;
        if (hsnCode !== undefined) product.hsnCode = String(hsnCode).trim();

        if (nextIsSerialized) {
            if (modelNumber !== undefined) product.modelNumber = modelNumber;
            product.productCode = undefined;
        } else {
            if (productCode !== undefined) {
                product.productCode = String(productCode).toUpperCase().trim();
            }
            product.modelNumber = undefined;
        }

        // Audit Fields
        product.updatedBy = req.user._id;
        product.updatedByRole = req.user.role;

        await product.save();

        return successResponse(res, "Product updated successfully", product);
    } catch (error) {
        console.error("Error updating product:", error);

        if (error.name === "ValidationError") {
            const messages = Object.values(error.errors).map((err) => err.message);
            return errorResponse(res, `Validation failed: ${messages.join(", ")}`, 400);
        }

        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern || { field: 1 })[0];
            return errorResponse(
                res,
                `${field} already exists. Please use a different value.`,
                409
            );
        }

        return errorResponse(res, "Internal server error", 500);
    }
};
