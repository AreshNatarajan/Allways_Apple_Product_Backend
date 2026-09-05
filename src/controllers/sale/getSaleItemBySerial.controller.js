// controllers/sale/getSaleItemBySerial.controller.js
import ProductSerial from "../../models/ProductSerial.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Single-serial lookup for the Sale List page's search box - same idea
// as getPurchaseItemBySerial.controller.js, mirrored for Sale: lets
// staff jump straight to one specific sold item (which can be buried
// inside a multi-item sale) instead of opening the Sale and hunting
// for it. Always 200 with `{ item: null }` on no match - this fires on
// ordinary free-text search input too (customer name, sale#...), where
// "no serial matched" is the normal case, not an error.
//
// Only matches a unit that's CURRENTLY sold (ProductSerial.saleId set) -
// once a unit is returned/exchanged out, that link is cleared (see
// createSaleReturn.controller.js/createSaleExchange.controller.js), so
// searching its serial afterward correctly stops surfacing a sale it's
// no longer actually part of.
export const getSaleItemBySerialController = async (req, res) => {
    try {
        const { serialNumber } = req.params;

        if (!serialNumber || !serialNumber.trim()) {
            return errorResponse(res, "Serial number is required", 400);
        }

        const serial = await ProductSerial.findOne({
            serialNumber: serialNumber.trim().toUpperCase(),
            isDeleted: false,
        })
            .select("productId serialNumber saleId description notes mdm images")
            .populate("productId", "name modelNumber")
            .populate({
                path: "saleId",
                select: "saleNumber items isDeleted customerId customerSnapshot",
                populate: { path: "customerId", select: "name" },
            })
            .lean();

        if (!serial || !serial.saleId || serial.saleId.isDeleted) {
            return successResponse(res, "No matching item found", { item: null });
        }

        const saleItem = serial.saleId.items.find(
            (it) => it.isSerialized && String(it.productSerialId) === String(serial._id)
        );
        if (!saleItem) {
            return successResponse(res, "No matching item found", { item: null });
        }

        // Snapshot-first, same convention established for every other
        // vendor/customer display in this app (see e.g.
        // getPurchaseItemBySerial.controller.js's matching vendor
        // resolution).
        const customerName = serial.saleId.customerSnapshot?.name || serial.saleId.customerId?.name || "";

        const item = {
            productName: serial.productId?.name || "",
            modelNumber: serial.productId?.modelNumber || "",
            serialNumber: serial.serialNumber,
            sellingPrice: saleItem.sellingPrice || 0,
            customerName,
            // "Details" modal fields - same shape UnitDetailsModal.jsx
            // already expects, sourced from ProductSerial since Sale
            // never carries its own copy of these (frozen at Purchase
            // time, never rewritten by a Sale).
            description: serial.description || { main: "", second: "" },
            notes: serial.notes || "",
            mdm: !!serial.mdm,
            images: serial.images || [],
            saleId: serial.saleId._id,
            saleNumber: serial.saleId.saleNumber || "",
        };

        return successResponse(res, "Item found", { item });
    } catch (error) {
        console.error("Get Sale Item By Serial Error:", error);
        return errorResponse(res, "Failed to look up serial number", 500);
    }
};
