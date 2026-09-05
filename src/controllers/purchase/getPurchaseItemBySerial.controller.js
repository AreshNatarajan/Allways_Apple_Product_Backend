// controllers/purchase/getPurchaseItemBySerial.controller.js
import ProductSerial from "../../models/ProductSerial.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Single-serial lookup for the Purchase List page's search box - lets
// staff jump straight to one specific item inside a purchase (which can
// have many items) instead of opening the Purchase and hunting for it.
// Always 200 with `{ item: null }` on no match (same soft "lookup, not
// a required resource" convention as checkSerialNumberExist.controller.js)
// rather than 404 - this gets called on ordinary free-text search input
// too (product name, vendor, PO#...), where "no serial matched" is the
// normal case, not an error.
//
// Returns just what SerialMatchRow.jsx (the Purchase List page's own
// trimmed-down row for this one match) needs: product name, model
// number, serial number, purchase/sale price, vendor, and the
// description/images/mdm "Details" fields (same shape UnitDetailsModal.jsx
// already expects) - plus purchaseId/purchaseNumber so that row's action
// icon can link back to the parent Purchase's detail page.
export const getPurchaseItemBySerialController = async (req, res) => {
    try {
        const { serialNumber } = req.params;

        if (!serialNumber || !serialNumber.trim()) {
            return errorResponse(res, "Serial number is required", 400);
        }

        const serial = await ProductSerial.findOne({
            serialNumber: serialNumber.trim().toUpperCase(),
            isDeleted: false,
        })
            .select("productId serialNumber purchaseId description notes mdm images")
            .populate("productId", "name modelNumber")
            .populate({
                path: "purchaseId",
                select: "purchaseNumber items isDeleted vendorId vendorSnapshot",
                populate: { path: "vendorId", select: "name" },
            })
            .lean();

        if (!serial || !serial.purchaseId || serial.purchaseId.isDeleted) {
            return successResponse(res, "No matching item found", { item: null });
        }

        // Same exact-match-by-serialNumber pattern as
        // getPurchaseById.controller.js's own item/serial merge - one
        // Purchase.items entry is exactly one physical unit for a
        // serialized product. Purchase.items has no isSerialized field
        // of its own (see Purchase.modal.js) - a non-empty
        // serialNumbers[0] is what makes an item "serialized" here,
        // same as everywhere else in this codebase.
        const purchaseItem = serial.purchaseId.items.find(
            (it) => it.serialNumbers?.[0]?.serialNumber === serial.serialNumber
        );
        if (!purchaseItem) {
            return successResponse(res, "No matching item found", { item: null });
        }

        // Snapshot-first, same convention established for every other
        // vendor/customer display in this app (see e.g.
        // getSerializedItemDetail.controller.js) - reflects who this was
        // actually from at purchase time, never a later live-Vendor edit.
        const vendorName = serial.purchaseId.vendorSnapshot?.name || serial.purchaseId.vendorId?.name || "";

        const item = {
            productName: serial.productId?.name || "",
            modelNumber: serial.productId?.modelNumber || "",
            serialNumber: serial.serialNumber,
            purchasePrice: purchaseItem.purchasePrice || 0,
            sellingPrice: purchaseItem.sellingPrice || 0,
            vendorName,
            // "Details" modal fields - same shape UnitDetailsModal.jsx
            // already expects (see SerializedProductDetailTable.jsx's
            // own identical usage).
            description: serial.description || { main: "", second: "" },
            notes: serial.notes || "",
            mdm: !!serial.mdm,
            images: serial.images || [],
            purchaseId: serial.purchaseId._id,
            purchaseNumber: serial.purchaseId.purchaseNumber || "",
        };

        return successResponse(res, "Item found", { item });
    } catch (error) {
        console.error("Get Purchase Item By Serial Error:", error);
        return errorResponse(res, "Failed to look up serial number", 500);
    }
};
