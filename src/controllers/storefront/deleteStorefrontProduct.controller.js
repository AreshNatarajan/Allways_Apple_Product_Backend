import mongoose from "mongoose";
import StorefrontProduct from "../../models/StorefrontProduct.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Soft-remove a listing entirely (not the same as un-listing - toggling
// isListed off via the upsert endpoint keeps the curated price/photos/
// description around for later; this is for "take this off the online
// catalog management list altogether"). Same soft-delete-only
// convention as everywhere else in this app - no hard delete.
export const deleteStorefrontProductController = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid listing ID", 400);
        }

        const listing = await StorefrontProduct.findOne({ _id: id, isDeleted: false });
        if (!listing) {
            return errorResponse(res, "Listing not found", 404);
        }

        listing.isDeleted = true;
        listing.deletedAt = new Date();
        listing.isListed = false;
        listing.updatedBy = req.user._id;
        await listing.save();

        return successResponse(res, "Listing removed successfully", { _id: listing._id });
    } catch (error) {
        console.error("Delete Storefront Product Error:", error);
        return errorResponse(res, "Failed to remove listing", 500);
    }
};
