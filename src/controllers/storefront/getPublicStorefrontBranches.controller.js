import ProductSerial from "../../models/ProductSerial.modal.js";
import Branch from "../../models/Branch.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// PUBLIC, unauthenticated - only branches that actually have at least
// one AVAILABLE serialized unit right now, so the storefront's branch
// filter never offers a branch with nothing to show. Only name/code
// exposed - never address/phone/bank details (those stay
// staff-authenticated-only, see branch.router.js).
export const getPublicStorefrontBranchesController = async (req, res) => {
    try {
        const branchIds = await ProductSerial.distinct("currentBranchId", { isDeleted: false, status: "AVAILABLE" });

        const branches = await Branch.find({ _id: { $in: branchIds }, isActive: true })
            .select("name code")
            .sort({ name: 1 })
            .lean();

        return successResponse(res, "Branches retrieved successfully", { branches });
    } catch (error) {
        console.error("Get Public Storefront Branches Error:", error);
        return errorResponse(res, "Failed to retrieve branches", 500);
    }
};
