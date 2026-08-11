import mongoose from "mongoose";
import User from "../../models/User.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// SUPER_ADMIN only - single-user read, including their own record
// (SUPER_ADMIN calling with their own id is not a special case, same as
// the generic PUT /user/:id).
export const getUserByIdController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid user ID", 400);
        }

        const user = await User.findOne({ _id: id, isDeleted: false })
            .select("-password -passwordChangedAt -__v")
            .populate("branchId", "_id name code isActive");

        if (!user) {
            return errorResponse(res, "User not found", 404);
        }

        return successResponse(res, "User fetched successfully", user, 200);

    } catch (error) {
        console.error("Get User By Id Error:", error);
        return errorResponse(res, "Server error while fetching user", 500);
    }
};
