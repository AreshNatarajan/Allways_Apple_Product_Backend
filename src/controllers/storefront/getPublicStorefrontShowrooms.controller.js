import Branch from "../../models/Branch.modal.js";
import { toPublicShowroom, PUBLIC_SHOWROOM_FIELDS } from "../../services/storefront/branchMap.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// PUBLIC, unauthenticated - every active branch as a showroom the
// storefront can show: name, phone (call / WhatsApp), address and its map
// (the Google Maps link entered on the ERP Branch form, plus an
// iframe-safe embed of the exact pin - see services/storefront/branchMap.js).
// Unlike /branches (only branches with stock, for the shop filter), this
// lists every active showroom. Never exposes bank / UPI / GST / email.
export const getPublicStorefrontShowroomsController = async (req, res) => {
    try {
        const branches = await Branch.find({ isActive: true, isDeleted: { $ne: true } })
            .select(PUBLIC_SHOWROOM_FIELDS)
            .sort({ name: 1 })
            .lean();
        const showrooms = await Promise.all(branches.map(toPublicShowroom));
        return successResponse(res, "Showrooms retrieved successfully", { showrooms });
    } catch (error) {
        console.error("Get Public Storefront Showrooms Error:", error);
        return errorResponse(res, "Failed to retrieve showrooms", 500);
    }
};
