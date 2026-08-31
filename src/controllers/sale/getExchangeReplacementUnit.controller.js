// controllers/sale/getExchangeReplacementUnit.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Serial lookup for Sale Exchange's "select replacement unit" step -
// NOT a reuse of GET /sale/scanner/:barcodeValue, deliberately: that
// route is gated by onlyBranchRoles and scopes to req.user.branchId,
// both correct for Sale Create (BRANCH_ADMIN/STAFF only, own branch)
// but wrong for Exchange, which SUPER_ADMIN can process too (see
// sale.router.js's own /:id/exchange comment) and which must scope to
// the SALE's branch, not whichever branch the acting user happens to
// have (SUPER_ADMIN has none). Serialized-only, matching Exchange
// phase 1's own scope.
export const getExchangeReplacementUnitController = async (req, res) => {
    try {
        const { id, barcodeValue } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid sale ID", 400);
        }
        if (!barcodeValue || barcodeValue.trim() === "") {
            return errorResponse(res, "Serial number is required", 400);
        }

        const sale = await Sale.findOne({ _id: id, isDeleted: false });
        if (!sale) {
            return errorResponse(res, "Sale not found", 404);
        }

        const trimmedSerial = barcodeValue.trim().toUpperCase();
        const gstConfig = await getOrCreateGstConfig();

        const serialMatch = await ProductSerial.findOne({ serialNumber: trimmedSerial })
            .populate("productId", "name productCode category isSerialized hsnCode isActive isDeleted modelNumber")
            .lean();

        if (!serialMatch || !serialMatch.productId) {
            return errorResponse(res, "No available unit found for this serial", 404);
        }

        const product = serialMatch.productId;

        if (!product.isSerialized) {
            return errorResponse(res, "This is a non-serialized batch barcode, not a serial number", 400);
        }
        if (product.isDeleted || !product.isActive) {
            return errorResponse(res, "This product is no longer active and cannot be sold", 404);
        }
        if (!product.hsnCode || !product.hsnCode.trim()) {
            return errorResponse(res, `${product.name} has no HSN/SAC code set on the product master`, 400);
        }

        const STATUS_MESSAGE = {
            ASSIGNED: `${product.name} (${serialMatch.serialNumber}) is assigned to a branch but hasn't been received yet`,
            RESERVED: `${product.name} (${serialMatch.serialNumber}) is reserved for an outbound transfer and cannot be sold right now`,
            IN_TRANSIT: `${product.name} (${serialMatch.serialNumber}) is in transit between branches`,
            SOLD: `${product.name} (${serialMatch.serialNumber}) has already been sold`,
            DAMAGED: `${product.name} (${serialMatch.serialNumber}) is marked as damaged and cannot be sold`,
            MISSING: `${product.name} (${serialMatch.serialNumber}) is marked as missing`,
        };

        if (serialMatch.status !== "AVAILABLE") {
            return errorResponse(
                res,
                STATUS_MESSAGE[serialMatch.status] || `${product.name} (${serialMatch.serialNumber}) is not currently available (status: ${serialMatch.status})`,
                404
            );
        }

        if (String(serialMatch.currentBranchId) !== String(sale.branchId)) {
            return errorResponse(res, `${product.name} (${serialMatch.serialNumber}) is available, but at a different branch`, 404);
        }

        return successResponse(res, "Available replacement unit found", {
            type: "serialized",
            productId: product._id,
            productName: product.name,
            productCode: product.productCode || "",
            category: product.category || "",
            modelNumber: product.modelNumber || "",
            isSerialized: true,
            serialNumber: serialMatch.serialNumber,
            productSerialId: serialMatch._id,
            purchasePrice: serialMatch.purchasePrice || 0,
            sellingPrice: serialMatch.sellingPrice || 0,
            gstApplicable: serialMatch.gstApplicable || false,
            gstPercent: gstConfig.marginSchemeRate || 0,
            hsnCode: product.hsnCode,
        });
    } catch (error) {
        console.error("Get Exchange Replacement Unit Error:", error);
        return errorResponse(res, error.message || "Failed to lookup replacement unit", 500);
    }
};
