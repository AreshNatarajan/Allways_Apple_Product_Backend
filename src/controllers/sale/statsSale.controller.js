// controllers/sale/statsSale.controller.js
import Sale from "../../models/Sale.modal.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const statsSaleController = async (req, res) => {
    try {
        const user = req.user;
        const branchId = user?.branchId;
        const role = user?.role;

        // Build match condition based on role
        const matchCondition = {
            isDeleted: false,
            isActive: true,
        };

        // ✅ If BRANCH_ADMIN, filter by their branch
        if (role === "BRANCH_ADMIN") {
            if (!branchId) {
                return errorResponse(
                    res,
                    "Branch ID not found for user",
                    400
                );
            }
            matchCondition.branchId = branchId;
        }
        // ✅ SUPER_ADMIN can see all branches (no branch filter)

        // For pending amount, use the same branch filter
        const pendingMatchCondition = {
            ...matchCondition,
            paymentStatus: "UNPAID",
        };

        // TOTAL SALES
        const totalSales = await Sale.countDocuments(matchCondition);

        // TOTAL REVENUE
        const totalRevenue = await Sale.aggregate([
            {
                $match: matchCondition,
            },
            {
                $group: {
                    _id: null,
                    totalRevenue: {
                        $sum: "$totalAmount",
                    },
                },
            },
        ]);

        // PENDING AMOUNT
        const pendingAmount = await Sale.aggregate([
            {
                $match: pendingMatchCondition,
            },
            {
                $group: {
                    _id: null,
                    totalPending: {
                        $sum: "$totalAmount",
                    },
                },
            },
        ]);

        // TOTAL UNITS SOLD
        const unitSold = await Sale.aggregate([
            {
                $match: matchCondition,
            },
            {
                $unwind: "$items",
            },
            {
                $group: {
                    _id: null,
                    totalUnits: {
                        $sum: "$items.quantity",
                    },
                },
            },
        ]);

        // PAID AMOUNT (For dashboard completeness)
        const paidAmount = await Sale.aggregate([
            {
                $match: {
                    ...matchCondition,
                    paymentStatus: "PAID",
                },
            },
            {
                $group: {
                    _id: null,
                    totalPaid: {
                        $sum: "$totalAmount",
                    },
                },
            },
        ]);

        // TOTAL SALES COUNT BY STATUS
        const statusCounts = await Sale.aggregate([
            {
                $match: matchCondition,
            },
            {
                $group: {
                    _id: "$paymentStatus",
                    count: { $sum: 1 },
                },
            },
        ]);

        // Format status counts
        const statusSummary = {
            PAID: 0,
            UNPAID: 0,
            PARTIAL: 0,
        };
        statusCounts.forEach(item => {
            if (item._id in statusSummary) {
                statusSummary[item._id] = item.count;
            }
        });

        return successResponse(res, "Sale statistics retrieved successfully", {
            // Overview
            totalSales,
            totalRevenue: totalRevenue[0]?.totalRevenue || 0,
            pendingAmount: pendingAmount[0]?.totalPending || 0,
            paidAmount: paidAmount[0]?.totalPaid || 0,
            unitSold: unitSold[0]?.totalUnits || 0,
            
            // Status breakdown
            statusSummary,
            
            // Branch info (for context)
            ...(role === "BRANCH_ADMIN" && { branchId }),
            ...(role === "SUPER_ADMIN" && { role: "SUPER_ADMIN" }),
        });

    } catch (error) {
        console.error("Sale Stats Error:", error);
        return errorResponse(
            res,
            error.message || "Error retrieving sale statistics",
            500
        );
    }
};