import mongoose from "mongoose";
import LoginHistory from "../../models/LoginHistory.model.js";
import paginate from "../../utils/pagination.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// SUPER_ADMIN only - lists login/logout history, optionally filtered to
// a single user via ?userId=.
export const listLoginHistoryController = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { userId } = req.query;

        const filter = {};

        if (userId) {
            if (!mongoose.Types.ObjectId.isValid(userId)) {
                return errorResponse(res, "Invalid user ID", 400);
            }
            filter.userId = userId;
        }

        const [history, total] = await Promise.all([
            LoginHistory.find(filter)
                .populate("userId", "_id name email role")
                .populate("branchId", "_id name code")
                .sort({ loginAt: -1 })
                .skip(skip)
                .limit(limit),
            LoginHistory.countDocuments(filter),
        ]);

        return successResponse(
            res,
            "Login history fetched successfully",
            {
                history,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit) || 1,
                },
            },
            200
        );

    } catch (error) {
        console.error("List Login History Error:", error);
        return errorResponse(res, "Failed to retrieve login history", 500);
    }
};
