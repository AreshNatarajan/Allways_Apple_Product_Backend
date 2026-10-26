import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { toPublicShowroom, PUBLIC_SHOWROOM_FIELDS } from "../../services/storefront/branchMap.js";

// PUBLIC, unauthenticated - one physical unit's detail page, sourced
// live from ProductSerial (see getPublicStorefrontProducts.controller.js's
// own comment for why). 404s for anything not currently AVAILABLE (sold/
// transferred/damaged/deleted) - a direct link to a unit that's no
// longer for sale should behave like it doesn't exist, not show stale
// info. serialNumber IS included here (unlike the list) so a customer
// can reference the exact unit in their WhatsApp/call inquiry.
export const getPublicStorefrontProductByIdController = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Product not found", 404);
        }

        // An iCloud unit is hidden from the storefront - a direct link 404s too.
        const serial = await ProductSerial.findOne({ _id: id, isDeleted: false, status: "AVAILABLE", icloud: { $ne: true }, showOnStorefront: { $ne: false } })
            .populate("productId", "name category modelNumber")
            .populate("currentBranchId", PUBLIC_SHOWROOM_FIELDS)
            .select("productId currentBranchId serialNumber sellingPrice description notes mdm images")
            .lean();

        if (!serial || !serial.productId) {
            return errorResponse(res, "Product not found", 404);
        }

        const product = {
            _id: serial._id,
            name: serial.productId.name,
            category: serial.productId.category,
            modelNumber: serial.productId.modelNumber || "",
            serialNumber: serial.serialNumber,
            price: serial.sellingPrice || 0,
            shortDescription: serial.description?.main || "",
            description: serial.description?.second || "",
            mdm: !!serial.mdm,
            // Staff sets `position` manually at Purchase Create/Edit time
            // (see SerialImageModal.jsx) - sorted here rather than
            // trusted as already-sorted, so the gallery's main/cover
            // photo (images[0]) is always the genuine position-1 image
            // even for a record saved before this field existed.
            images: [...(serial.images || [])].sort((a, b) => (a.position || 0) - (b.position || 0)),
            // The showroom holding this unit - phone (call / WhatsApp),
            // address and its map (exact pin, iframe-safe).
            branch: await toPublicShowroom(serial.currentBranchId),
        };

        return successResponse(res, "Product retrieved successfully", { product });
    } catch (error) {
        console.error("Get Public Storefront Product By Id Error:", error);
        return errorResponse(res, "Failed to retrieve product", 500);
    }
};
