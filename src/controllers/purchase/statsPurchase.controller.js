// controllers/purchase/statsPurchase.controller.js
import Purchase from "../../models/Purchase.modal.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const statsPurchaseController = async (req, res) => {


    consolre.log("statsPurchaseController called");
    
    try {
        const user = req.user;

        // ✅ Build filter based on user permissions
        const filter = {
            isDeleted: false,
        };

        // ✅ Branch filter for non-super admins
        if (user?.role !== "SUPER_ADMIN" && user?.branchId) {
            filter.branchId = user.branchId;
        }

        // ============================================
        // 1. PURCHASE OVERVIEW
        // ============================================
        const total = await Purchase.countDocuments(filter);

        const totalAmountResult = await Purchase.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: null,
                    totalAmount: { $sum: "$totalAmount" },
                },
            },
        ]);
        const totalAmount = totalAmountResult[0]?.totalAmount || 0;

        // ============================================
        // 2. PURCHASE STATUS STATISTICS
        // ============================================
        const statusStats = await Purchase.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: "$status",
                    count: { $sum: 1 },
                },
            },
        ]);

        // Initialize with default values
        const purchaseStatus = {
            completed: 0,
            draft: 0,
            cancelled: 0,
        };

        // Map status values from aggregation (using actual enum values)
        statusStats.forEach((item) => {
            const status = item._id?.toUpperCase() || item._id;
            if (status === "COMPLETED") {
                purchaseStatus.completed = item.count;
            } else if (status === "DRAFT") {
                purchaseStatus.draft = item.count;
            } else if (status === "CANCELLED") {
                purchaseStatus.cancelled = item.count;
            }
        });

        // ============================================
        // 3. PAYMENT STATUS STATISTICS
        // ============================================
        const paymentStatusStats = await Purchase.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: "$paymentStatus",
                    count: { $sum: 1 },
                },
            },
        ]);

        // Initialize with default values
        const paymentStatus = {
            paid: 0,
            partialPayment: 0,
            unpaid: 0,
        };

        // Map payment status values from aggregation (using actual enum values)
        paymentStatusStats.forEach((item) => {
            const status = item._id?.toUpperCase() || item._id;
            if (status === "PAID") {
                paymentStatus.paid = item.count;
            } else if (status === "PARTIAL") {
                paymentStatus.partialPayment = item.count;
            } else if (status === "PENDING") {
                paymentStatus.unpaid = item.count;
            }
        });

        // ============================================
        // 4. FINANCIAL STATISTICS
        // ============================================
        const financialStats = await Purchase.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: null,
                    totalPurchaseAmount: { $sum: "$totalAmount" },
                    totalPaidAmount: { $sum: "$paidAmount" },
                },
            },
        ]);

        const totalPurchaseAmount = financialStats[0]?.totalPurchaseAmount || 0;
        const totalPaidAmount = financialStats[0]?.totalPaidAmount || 0;
        const totalOutstandingAmount = totalPurchaseAmount - totalPaidAmount;

        // ============================================
        // 5. RESPONSE
        // ============================================
        return successResponse(res, "Purchase statistics retrieved successfully", {
            overview: {
                total,
                totalAmount,
            },
            purchaseStatus,
            paymentStatus,
            financial: {
                totalPurchaseAmount,
                totalPaidAmount,
                totalOutstandingAmount,
            },
        });

    } catch (error) {
        console.error("Error retrieving purchase statistics:", error);
        return errorResponse(res, "Internal server error", 500);
    }
};


