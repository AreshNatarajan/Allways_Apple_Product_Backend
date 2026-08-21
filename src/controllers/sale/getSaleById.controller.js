// controllers/sale/getSaleById.controller.js
import Sale from "../../models/Sale.modal.js";
import SaleEditHistory from "../../models/SaleEditHistory.modal.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

// Sale Detail page needs every referenced person/entity resolved in one
// round trip. Every populate below targets a distinct top-level or
// array-of-subdocuments path, so Mongoose issues one batched query per
// path regardless of how many items the sale has (never one query per
// item - that would be the N+1 pattern this is written to avoid).
export const getSaleByIdController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return errorResponse(res, "Sale ID is required", 400);
        }

        const sale = await Sale.findById(id)
            .populate("customerId", "name mobile email address gstNumber")
            .populate("branchId", "name code email phones address bankDetails upiQrImage googleMapUrl")
            .populate("createdBy", "name email role")
            .populate("updatedBy", "name email role")
            .populate("items.productId", "name category description productCode hsnCode isSerialized")
            .populate("items.productSerialId", "serialNumber modelNumber status description images notes")
            .populate("paymentDetails.handledBy.userId", "name email role")
            .populate("handledBy.userId", "name email role")
            .populate("reviewedBy", "name email")
            .lean();

        if (!sale) {
            return errorResponse(res, "Sale not found", 404);
        }

        // Sale is single-branch by construction (branchId is always the
        // authenticated user's own branch at creation time, never
        // per-item like Purchase's CENTRAL multi-branch case) - every
        // item's "branch" is exactly this sale's own branch. Reusing the
        // one already-populated branch object per item is free (no
        // extra query) and correct, rather than re-populating a branch
        // reference on every single item.
        const branchDetails = sale.branchId || null;

        const totalItems = sale.items.reduce((sum, item) => sum + (item.quantity || 1), 0);
        const serializedItems = sale.items.filter((item) => item.isSerialized).length;
        const nonSerializedItems = sale.items.filter((item) => !item.isSerialized).length;

        const formattedItems = sale.items.map((item) => {
            const product = item.productId || null;
            const serial = item.productSerialId || null;

            return {
                ...item,
                // productId/productSerialId are populated above (for the
                // flattened display fields below) - overridden back to
                // plain IDs here, since Sale Edit uses these exact field
                // names as correction/removal keys (String(item.
                // productSerialId) etc.) and a populated sub-document
                // would stringify to the useless literal "[object
                // Object]" instead of the real id, silently breaking
                // every item correction (updateSale.controller.js's own
                // ObjectId.isValid check would then reject it and skip
                // the correction entirely - confirmed root cause of a
                // real "No changes detected" bug). Every populated field
                // that's actually needed is already flattened onto its
                // own top-level key below (productName, productCategory,
                // productDescription, images, notes, modelNumber).
                productId: product?._id || item.productId || null,
                productSerialId: serial?._id || item.productSerialId || null,
                // Product master fields - never stored flat on the item
                // (createSale.controller.js doesn't stamp productName/
                // category there), so these only exist via this populate.
                productName: product?.name || item.productName || "Unknown Product",
                productCategory: product?.category || "",
                // Ownership split: a serialized item's description/images
                // are this exact physical unit's own (ProductSerial),
                // never the parent Product's - a non-serialized item has
                // no per-unit record at all, and non-serialized products
                // have no image concept, so images is always the
                // serialized unit's own or empty.
                productDescription: item.isSerialized ? (serial?.description || { main: "", second: "" }) : (product?.description || ""),
                images: item.isSerialized ? (serial?.images || []) : [],
                // notes is a serialized-unit-only concept (internal/
                // staff-facing note, entered per-unit at Purchase time) -
                // no Product-level equivalent, so this stays blank for a
                // non-serialized item rather than falling back to
                // anything on Product.
                notes: item.isSerialized ? (serial?.notes || "") : "",
                productCode: product?.productCode || item.productCode || "",

                // Model Number is serialized-only, and the historically
                // accurate value lives per-unit on ProductSerial (two
                // serials of the same product can legitimately have
                // different models) - never the current Product master
                // value, which can drift after the sale.
                modelNumber: item.isSerialized ? (serial?.modelNumber || item.modelNumber || "") : "",

                // Serial Number: prefer the frozen value stored on the
                // item itself (the historical record), falling back to
                // the live ProductSerial doc only if that's ever blank.
                serialNumber: item.serialNumber || serial?.serialNumber || "",

                // The item's own `barcode` field is the non-serialized
                // batch barcode - ProductSerial has no `barcode` field
                // at all, so it must never be used to overwrite this.
                barcode: item.barcode || "",

                branchDetails,

                // finalAmount is the real, GST/discount-inclusive line
                // total already computed and frozen at sale time -
                // itemTotal is kept only for response-shape backward
                // compatibility with existing callers of this field.
                itemTotal: item.finalAmount,
            };
        });

        // Edit history - EOD review reads this to see what changed on
        // this sale over time (the edit already applied by the time
        // review happens, so this is the only surviving record of
        // before/after values). Mirrors getPurchaseById.controller.js's
        // identical pattern.
        const editHistory = await SaleEditHistory.find({ saleId: sale._id })
            .sort({ createdAt: -1 })
            .populate("editedBy", "name email")
            .lean();

        const responseData = {
            ...sale,
            items: formattedItems,
            editHistory,
            summary: {
                totalItems,
                serializedItems,
                nonSerializedItems,
                // Sale has no round-off concept in its business logic
                // today (unlike Purchase) - reported honestly as 0
                // rather than inventing a calculation that doesn't
                // exist server-side.
                roundOff: 0,
            },
            formattedDate: sale.saleDate
                ? new Date(sale.saleDate).toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                })
                : null,
        };

        return successResponse(res, "Sale retrieved successfully", responseData);
    } catch (error) {
        console.error("Get Sale Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve sale", 500);
    }
};
