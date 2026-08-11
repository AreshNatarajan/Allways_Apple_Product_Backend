// controllers/customer/getCustomerStats.controller.js
import Customer from "../../models/Customer.modal.js";
import { getCustomerBranchFilter } from "../../services/customerBranchScope.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

/**
 * GET CUSTOMER STATS
 * - SUPER_ADMIN: Can see all branch data
 * - BRANCH_ADMIN / STAFF: Can only see their branch data
 */
export const getCustomerStatsController = async (req, res) => {
    try {
        const user = req.user;
        const role = user?.role;

        // ✅ Branch-scoped for BRANCH_ADMIN/STAFF, unrestricted for SUPER_ADMIN
        if (role !== "SUPER_ADMIN" && !user?.branchId) {
            return errorResponse(
                res,
                "Branch ID not found for user",
                400
            );
        }

        const matchCondition = {
            isDeleted: false,
            ...getCustomerBranchFilter(user),
        };

        const stats = await Customer.aggregate([
            {
                $match: matchCondition,
            },
            {
                $group: {
                    _id: null,
                    totalCustomers: { $sum: 1 },
                    activeCustomers: {
                        $sum: {
                            $cond: [{ $eq: ["$isActive", true] }, 1, 0],
                        },
                    },
                    inactiveCustomers: {
                        $sum: {
                            $cond: [{ $eq: ["$isActive", false] }, 1, 0],
                        },
                    },
                },
            },
        ]);

        const result = stats[0] || {
            totalCustomers: 0,
            activeCustomers: 0,
            inactiveCustomers: 0,
        };

        return successResponse(
            res,
            "Customer stats retrieved successfully",
            result
        );

    } catch (error) {
        console.error("Get Customer Stats Error:", error);
        return errorResponse(
            res,
            error.message || "Error retrieving customer stats",
            500
        );
    }
};


