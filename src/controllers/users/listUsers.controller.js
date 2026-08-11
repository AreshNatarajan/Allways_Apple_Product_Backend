import User from "../../models/User.js";
import paginate from "../../utils/pagination.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// SUPER_ADMIN only - lists users with optional role/branchId/search filters.
export const listUsersController = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { role, branchId, isActive, search = "" } = req.query;

        const filter = { isDeleted: false };

        if (role) {
            filter.role = role;
        }

        if (branchId) {
            filter.branchId = branchId;
        }

        // Optional explicit filter - "Get active users" vs "Get all
        // users" (default, no filter, includes deactivated ones so
        // SUPER_ADMIN can find and reactivate them).
        if (isActive === "true") {
            filter.isActive = true;
        } else if (isActive === "false") {
            filter.isActive = false;
        }

        if (search && search.trim()) {
            filter.$or = [
                { name: { $regex: search.trim(), $options: "i" } },
                { email: { $regex: search.trim(), $options: "i" } },
            ];
        }

        // Stats always reflect the whole active user base (isDeleted: false),
        // independent of the current search/role/branchId/isActive filters -
        // an overview for the stats bar, not a "count matching this page's
        // filter" figure. Additive field only, existing users/pagination
        // shape is untouched.
        const statsFilter = { isDeleted: false };

        const [users, total, statsTotal, statsActive, statsInactive, statsSuperAdmins, statsBranchAdmins, statsStaff] = await Promise.all([
            User.find(filter)
                .select("-password -passwordChangedAt -__v")
                .populate("branchId", "_id name code")
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
            User.countDocuments(filter),
            User.countDocuments(statsFilter),
            User.countDocuments({ ...statsFilter, isActive: true }),
            User.countDocuments({ ...statsFilter, isActive: false }),
            User.countDocuments({ ...statsFilter, role: "SUPER_ADMIN" }),
            User.countDocuments({ ...statsFilter, role: "BRANCH_ADMIN" }),
            User.countDocuments({ ...statsFilter, role: "STAFF" }),
        ]);

        return successResponse(
            res,
            "Users fetched successfully",
            {
                users,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit) || 1,
                },
                stats: {
                    total: statsTotal,
                    active: statsActive,
                    inactive: statsInactive,
                    superAdmins: statsSuperAdmins,
                    branchAdmins: statsBranchAdmins,
                    staff: statsStaff,
                },
            },
            200
        );

    } catch (error) {
        console.error("List Users Error:", error);
        return errorResponse(res, "Failed to retrieve users", 500);
    }
};
