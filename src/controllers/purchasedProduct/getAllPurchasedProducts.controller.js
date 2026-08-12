// controllers/product/getAllPurchasedProducts.controller.js
import ProductSerial from "../../models/ProductSerial.modal.js";
import Branch from "../../models/Branch.modal.js"; // ✅ Import instead of require
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import paginate from "../../utils/pagination.js";
import { getBranchFilter } from "../../middleware/branchFilter.js";

export const getAllPurchasedProductsController = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { search = "", status = "" } = req.query;
        const user = req.user;

        // ✅ Build query
        const query = {};

        // ✅ Apply branch filter
        const branchFilter = getBranchFilter(user);
        
        // ✅ For Branch Admin: Filter by currentBranchId
        if (branchFilter && branchFilter.branchId) {
            query.currentBranchId = branchFilter.branchId;
        }

        // ✅ Status filter
        if (status) {
            query.status = status;
        } else {
            // ✅ Default statuses
            query.status = {
                $in: ["AVAILABLE", "SOLD", "RETURNED"],
            };
        }

        // ✅ Search filter
        if (search && search.trim() !== "") {
            const searchRegex = new RegExp(search.trim(), "i");
            query.$or = [
                { serialNumber: { $regex: searchRegex } },
                { barcode: { $regex: searchRegex } },
            ];
        }

        // ✅ Get purchased products with pagination
        const purchasedProducts = await ProductSerial.find(query)
            .populate("productId", "name sku category sellingPrice")
            .populate("purchaseId", "purchaseNumber purchaseDate")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await ProductSerial.countDocuments(query);

        // ✅ Get summary statistics with branch filter
        const statsQuery = {};
        
        if (branchFilter && branchFilter.branchId) {
            statsQuery.currentBranchId = branchFilter.branchId;
        }

        // ✅ Count by status
        const statusStats = {
            total: await ProductSerial.countDocuments(statsQuery),
            available: await ProductSerial.countDocuments({ 
                ...statsQuery, 
                status: "AVAILABLE" 
            }),
            sold: await ProductSerial.countDocuments({ 
                ...statsQuery, 
                status: "SOLD" 
            }),
            returned: await ProductSerial.countDocuments({ 
                ...statsQuery, 
                status: "RETURNED" 
            }),
            damaged: await ProductSerial.countDocuments({ 
                ...statsQuery, 
                status: "DAMAGED" 
            }),
            inTransit: await ProductSerial.countDocuments({ 
                ...statsQuery, 
                status: "IN_TRANSIT" 
            }),
        };

        // ✅ Get branch name for response
        let branchName = "All Branches";
        if (branchFilter && branchFilter.branchId) {
            const branch = await Branch.findById(branchFilter.branchId) // ✅ Now Branch is imported
                .select("name code")
                .lean();
            if (branch) {
                branchName = `${branch.name} (${branch.code})`;
            }
        }

        // ✅ Transform data for frontend
        const transformedProducts = purchasedProducts.map(product => ({
            _id: product._id,
            serialNumber: product.serialNumber,
            barcode: product.barcode,
            status: product.status,
            productId: product.productId ? {
                _id: product.productId._id,
                name: product.productId.name,
                sku: product.productId.sku,
                category: product.productId.category,
                sellingPrice: product.productId.sellingPrice,
            } : null,
            // Each row here is one physical serialized unit - its own
            // description/images are the source of truth, never the
            // parent Product's (which don't describe this specific
            // unit's condition/photos).
            description: product.description || { main: "", second: "" },
            images: product.images || [],
            notes: product.notes || "",
            purchaseId: product.purchaseId ? {
                _id: product.purchaseId._id,
                purchaseNumber: product.purchaseId.purchaseNumber,
                purchaseDate: product.purchaseId.purchaseDate,
            } : null,
            currentBranchId: product.currentBranchId,
            assignedBranchId: product.assignedBranchId,
            purchasePrice: product.purchasePrice,
            sellingPrice: product.sellingPrice,
            soldAt: product.soldAt,
            saleId: product.saleId,
            transferredAt: product.transferredAt,
            receivedAt: product.receivedAt,
            createdAt: product.createdAt,
            updatedAt: product.updatedAt,
        }));

        return successResponse(res, "Purchased products retrieved successfully", {
            purchasedProducts: transformedProducts,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / limit),
            },
            summary: {
                branch: branchName,
                branchId: branchFilter?.branchId || null,
                ...statusStats,
            },
            filters: {
                search: search || "",
                status: status || "ALL",
            },
        });

    } catch (error) {
        console.error("Get Purchased Products Error:", error);
        return errorResponse(res, "Failed to retrieve purchased products", 500);
    }
};