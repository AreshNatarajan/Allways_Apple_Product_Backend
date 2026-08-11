import Branch from "../../models/Branch.modal.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

/**
 * GET BRANCH STATS (SUPER ADMIN ONLY)
 */
export const getBranchStatsController = async (req, res) => {
    try {

        const user = req.user;


        console.log("USER DEATILS : ",user)

        /**
         * ONLY SUPER ADMIN CAN ACCESS
         */
        if (user.role !== "SUPER_ADMIN") {
            return errorResponse(
                res,
                "Access denied. Only Super Admin can view branch stats",
                403
            );
        }

        /**
         * GET ALL BRANCHES
         */
        const branches = await Branch.find();

        const totalBranches = branches.length;

        const activeBranches = branches.filter(
            (b) => b.isActive === true
        ).length;

        const inactiveBranches = branches.filter(
            (b) => b.isActive === false
        ).length;

        const stats = {
            totalBranches,
            activeBranches,
            inactiveBranches,
        };

        return successResponse(
            res,
            "Branch stats retrieved successfully",
            stats
        );

    } catch (error) {

        console.error(
            "Get Branch Stats Error:",
            error
        );

        return errorResponse(
            res,
            "Error retrieving branch stats",
            500
        );
    }
};