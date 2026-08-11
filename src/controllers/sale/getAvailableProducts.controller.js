
// controllers/sale/getAvailableProducts.controller.js

import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Inventory from "../../models/Inventory.modal.js";
import Product from "../../models/Product.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Purchase from "../../models/Purchase.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const getAvailableProductsController = async (req, res) => {
    try {
        const userBranchId = req.user?.branchId;

        if (!userBranchId) {
            return errorResponse(res, "Branch not assigned to user", 400);
        }

        if (!mongoose.Types.ObjectId.isValid(userBranchId)) {
            return errorResponse(res, "Invalid branch ID", 400);
        }

        const { search = "" } = req.query;
        const trimmedSearch = search.trim();

        const branchObjectId = new mongoose.Types.ObjectId(userBranchId);

        console.log("Search Query:", trimmedSearch);

        // ============================================================
        // STEP 1: BUILD PRODUCT QUERY
        // ============================================================

        const productQuery = {
            isDeleted: false,
            isActive: true,
        };

        if (trimmedSearch !== "") {
            const searchRegex = new RegExp(trimmedSearch, "i");

            productQuery.$or = [
                // Common
                {
                    name: {
                        $regex: searchRegex,
                    },
                },

                // Non-serialized product
                {
                    productCode: {
                        $regex: searchRegex,
                    },
                },

                // Serialized product
                {
                    modelNumber: {
                        $regex: searchRegex,
                    },
                },
            ];
        }

        // ============================================================
        // STEP 2: GET PRODUCTS
        // ============================================================

        const products = await Product.find(productQuery)
            .lean();

        if (products.length === 0) {
            return successResponse(
                res,
                "Products retrieved successfully",
                {
                    items: [],
                    summary: {
                        totalProducts: 0,
                        availableProducts: 0,
                        outOfStockProducts: 0,
                        searchTerm: trimmedSearch || "all",
                    },
                }
            );
        }

        // ============================================================
        // STEP 3: PRODUCT IDS
        // ============================================================

        const productIds = products.map(
            (product) => product._id
        );

        // ============================================================
        // STEP 4: GET NON-SERIALIZED BATCH STOCK
        //
        // Only non-serialized products use BatchStock here.
        // ============================================================

        const batchStocks = await BatchStock.find({
            branchId: branchObjectId,
            productId: {
                $in: productIds,
            },
            status: "ACTIVE",
            availableQuantity: {
                $gt: 0,
            },
        })
            .sort({
                createdAt: -1,
            })
            .lean();

        // Latest available batch per product
        const batchMap = new Map();

        for (const batch of batchStocks) {
            const productId = batch.productId.toString();

            if (!batchMap.has(productId)) {
                batchMap.set(productId, {
                    batchId: batch._id,
                    batchNumber: batch.batchNumber || "",
                    barcode: batch.barcode || "",
                    purchaseId: batch.purchaseId || null,
                    purchasePrice: batch.purchasePrice || 0,
                    sellingPrice: batch.sellingPrice || 0,
                    quantity: batch.quantity || 0,
                    availableQuantity:
                        batch.availableQuantity || 0,
                });
            }
        }

        // ============================================================
        // STEP 5: GET NON-SERIALIZED INVENTORY STOCK
        // ============================================================

        const inventoryStock = await Inventory.find({
            branchId: branchObjectId,
            productId: {
                $in: productIds,
            },
        })
            .lean();

        const inventoryMap = new Map();

        for (const inventory of inventoryStock) {
            inventoryMap.set(
                inventory.productId.toString(),
                inventory.quantity || 0
            );
        }

        // ============================================================
        // STEP 6: GET SERIALIZED PRODUCT COUNTS
        // ============================================================

        const serialCounts = await ProductSerial.aggregate([
            {
                $match: {
                    currentBranchId: branchObjectId,
                    productId: {
                        $in: productIds,
                    },
                    status: "AVAILABLE",
                },
            },
            {
                $group: {
                    _id: "$productId",
                    serialCount: {
                        $sum: 1,
                    },
                },
            },
        ]);

        const serialMap = new Map();

        for (const serialData of serialCounts) {
            serialMap.set(
                serialData._id.toString(),
                serialData.serialCount || 0
            );
        }

        // ============================================================
        // STEP 7: GET SERIALIZED PRODUCT PURCHASE PRICES
        //
        // Serialized products get their purchase/selling price
        // from Purchase records rather than BatchStock.
        // ============================================================

        const availableSerials = await ProductSerial.find({
            currentBranchId: branchObjectId,
            productId: {
                $in: productIds,
            },
            status: "AVAILABLE",
            purchaseId: {
                $ne: null,
            },
        })
            .select("productId purchaseId")
            .populate({
                path: "purchaseId",
                select: "items purchaseNumber",
            })
            .lean();

        const serializedPriceMap = new Map();

        for (const serial of availableSerials) {
            const productId = serial.productId.toString();

            // Already have price information for this product
            if (serializedPriceMap.has(productId)) {
                continue;
            }

            const purchase = serial.purchaseId;

            if (!purchase) {
                continue;
            }

            const purchaseItem = purchase.items?.find(
                (item) =>
                    item.productId?.toString() === productId
            );

            if (!purchaseItem) {
                continue;
            }

            serializedPriceMap.set(productId, {
                purchasePrice:
                    purchaseItem.purchasePrice || 0,

                sellingPrice:
                    purchaseItem.sellingPrice || 0,

                gstApplicable:
                    purchaseItem.gstApplicable || false,

                purchaseGstPercent:
                    purchaseItem.purchaseGstPercent || 0,

                hsnCode:
                    purchaseItem.hsnCode || "",

                purchaseId:
                    purchase._id,

                purchaseNumber:
                    purchase.purchaseNumber || "",
            });
        }

        // ============================================================
        // STEP 8: BUILD RESPONSE
        // ============================================================

        const items = products.map((product) => {
            const productId = product._id.toString();

            const isSerialized =
                product.isSerialized === true;

            // --------------------------------------------------------
            // SERIALIZED PRODUCT
            // --------------------------------------------------------

            if (isSerialized) {
                const serialCount =
                    serialMap.get(productId) || 0;

                const priceData =
                    serializedPriceMap.get(productId) || {
                        purchasePrice: 0,
                        sellingPrice: 0,
                        gstApplicable: false,
                        purchaseGstPercent: 0,
                        hsnCode: "",
                        purchaseId: null,
                        purchaseNumber: "",
                    };

                return {
                    _id: product._id,
                    productId: product._id,

                    productName: product.name || "",

                    // Serialized product uses MODEL NUMBER
                    modelNumber:
                        product.modelNumber || "",

                    // Do not use productCode for serialized products
                    productCode: "",

                    category:
                        product.category || "",

                    isSerialized: true,

                    purchasePrice:
                        priceData.purchasePrice,

                    sellingPrice:
                        priceData.sellingPrice,

                    gstApplicable:
                        priceData.gstApplicable,

                    purchaseGstPercent:
                        priceData.purchaseGstPercent,

                    hsnCode:
                        priceData.hsnCode,

                    purchaseId:
                        priceData.purchaseId,

                    purchaseNumber:
                        priceData.purchaseNumber,

                    currentStock:
                        serialCount,

                    serialCount:
                        serialCount,

                    isAvailable:
                        serialCount > 0,
                };
            }

            // --------------------------------------------------------
            // NON-SERIALIZED PRODUCT
            // --------------------------------------------------------

            const batchData =
                batchMap.get(productId) || null;

            const currentStock =
                inventoryMap.get(productId) || 0;

            return {
                _id: product._id,
                productId: product._id,

                productName:
                    product.name || "",

                // Non-serialized product uses PRODUCT CODE
                productCode:
                    product.productCode || "",

                // Not required for non-serialized
                modelNumber: "",

                category:
                    product.category || "",

                isSerialized: false,

                purchasePrice:
                    batchData?.purchasePrice || 0,

                sellingPrice:
                    batchData?.sellingPrice || 0,

                // Non-serialized GST is handled in sale
                // based on the product/batch sale architecture
                gstApplicable: true,

                purchaseGstPercent: 0,

                hsnCode: "",

                // Latest available batch details
                batchId:
                    batchData?.batchId || null,

                batchNumber:
                    batchData?.batchNumber || "",

                barcode:
                    batchData?.barcode || "",

                purchaseId:
                    batchData?.purchaseId || null,

                batchQuantity:
                    batchData?.quantity || 0,

                batchAvailableQuantity:
                    batchData?.availableQuantity || 0,

                currentStock:
                    currentStock,

                serialCount: 0,

                isAvailable:
                    currentStock > 0 &&
                    !!batchData,
            };
        });

        // ============================================================
        // STEP 9: SORT
        //
        // Available products first.
        // Then alphabetical by product name.
        // ============================================================

        items.sort((a, b) => {
            if (
                a.isAvailable &&
                !b.isAvailable
            ) {
                return -1;
            }

            if (
                !a.isAvailable &&
                b.isAvailable
            ) {
                return 1;
            }

            return a.productName.localeCompare(
                b.productName
            );
        });

        // ============================================================
        // STEP 10: SUMMARY
        // ============================================================

        const summary = {
            totalProducts:
                items.length,

            availableProducts:
                items.filter(
                    (product) => product.isAvailable
                ).length,

            outOfStockProducts:
                items.filter(
                    (product) => !product.isAvailable
                ).length,

            serializedProducts:
                items.filter(
                    (product) => product.isSerialized
                ).length,

            nonSerializedProducts:
                items.filter(
                    (product) => !product.isSerialized
                ).length,

            searchTerm:
                trimmedSearch || "all",
        };

        // ============================================================
        // STEP 11: RESPONSE
        // ============================================================

        return successResponse(
            res,
            "Products retrieved successfully",
            {
                items,
                summary,
            }
        );

    } catch (error) {
        console.error(
            "Get Available Products Error:",
            error
        );

        return errorResponse(
            res,
            error.message ||
                "Failed to retrieve products",
            500
        );
    }
};
