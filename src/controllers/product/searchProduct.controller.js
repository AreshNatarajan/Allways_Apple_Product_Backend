import Product from "../../models/Product.modal.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getProductOptionsController = async (
    req,
    res
) => {

    try {

        const {
            search = "",
            type = "", // "serialized" or "non-serialized" or empty for all
        } = req.query;

        const query = {
            isDeleted: false,
            isActive: true,
        };

        // ✅ Apply type filter (serialized / non-serialized)
        if (type === "serialized") {
            query.isSerialized = true;
        } else if (type === "non-serialized") {
            query.isSerialized = false;
        }

        // ✅ Search filter - search across all relevant fields
        if (search && search.trim()) {
            const searchTerm = search.trim();
            query.$or = [
                { name: { $regex: searchTerm, $options: "i" } },
                { productCode: { $regex: searchTerm, $options: "i" } },
                { modelNumber: { $regex: searchTerm, $options: "i" } },
                { hsnCode: { $regex: searchTerm, $options: "i" } },
                { category: { $regex: searchTerm, $options: "i" } },
            ];
        }

        // ✅ Get products with ALL fields populated based on type
        const products = await Product.find(
            query,
            {
                // Basic Info
                name: 1,
                category: 1,
                description: 1,

                // Type Info
                isSerialized: 1,

                // Serialized fields
                modelNumber: 1,

                // Non-serialized fields
                productCode: 1,
                hsnCode: 1,
                
                // Status
                isActive: 1,
                
                // Timestamps
                createdAt: 1,
                updatedAt: 1,
            }
        )
            .sort({ name: 1 })
            .limit(20);

        // ✅ Format response with type-specific fields
        const formattedProducts = products.map(product => {
            const baseProduct = {
                _id: product._id,
                name: product.name,
                category: product.category,
                description: product.description,
                isSerialized: product.isSerialized,
                isActive: product.isActive,
                createdAt: product.createdAt,
                updatedAt: product.updatedAt,
            };

            // ✅ Add type-specific fields
            if (product.isSerialized) {
                return {
                    ...baseProduct,
                    modelNumber: product.modelNumber || '',
                    productCode: null, // Not applicable
                    hsnCode: null,     // Not applicable
                    displayCode: product.modelNumber || 'N/A',
                    codeLabel: 'Model Number',
                };
            } else {
                return {
                    ...baseProduct,
                    modelNumber: '',   // Not applicable
                    productCode: product.productCode || '',
                    hsnCode: product.hsnCode || '',
                    displayCode: product.productCode || 'N/A',
                    codeLabel: 'Product Code',
                };
            }
        });

        return successResponse(
            res,
            "Products retrieved successfully",
            {
                products: formattedProducts,
                filters: {
                    search: search || "",
                    type: type || "all",
                },
                total: formattedProducts.length,
            }
        );

    } catch (error) {

        console.error(
            "Get Product Options Error:",
            error
        );

        return errorResponse(
            res,
            error.message || "Internal server error",
            500
        );

    }

};


