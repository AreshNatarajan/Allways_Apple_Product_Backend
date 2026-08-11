import Branch from "../../models/Branch.modal.js";
import paginate from "../../utils/pagination.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getBranchesController = async (req, res) => {

    try {

        // PAGINATION
        const { page, limit, skip } = paginate(req);

        // This route is already SUPER_ADMIN-only (see branch.router.js).
        // Default is active branches only; includeInactive=true lets
        // SUPER_ADMIN find a deactivated branch worth reactivating.
        // isActive=true/false takes precedence when explicitly provided
        // (drives the frontend's Active/All filter).
        const { includeInactive, isActive, search } = req.query;
        const filter = { isDeleted: false };
        if (isActive === "true") {
            filter.isActive = true;
        } else if (isActive === "false") {
            filter.isActive = false;
        } else if (includeInactive !== "true") {
            filter.isActive = true;
        }

        if (search?.trim()) {
            filter.$or = [
                { name: { $regex: search.trim(), $options: "i" } },
                { code: { $regex: search.trim(), $options: "i" } },
            ];
        }

        // GET BRANCHES
        const branches = await Branch.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        // TOTAL COUNT
        const total = await Branch.countDocuments(filter);

        return successResponse(
            res,
            "Branches retrieved successfully",
            {
                branches,
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit),
                },
            }
        );

    } catch (error) {

        console.error("Error retrieving branches:", error);

        return errorResponse(
            res,
            "Internal server error",
            500
        );
    }
};