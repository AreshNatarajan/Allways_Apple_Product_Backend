import Purchase from "../../models/Purchase.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const updatePurchaseController = async (
    req,
    res
) => {

    try {

        const { id } = req.params;

        const purchase =
            await Purchase.findById(id);

        if (!purchase) {

            return errorResponse(
                res,
                "Purchase not found",
                404
            );
        }

        const {
            vendorId,
            supplierInvoiceNumber,
            purchaseDate,
            paymentStatus,
            paidAmount,
            pendingAmount,
            status,
            notes,
        } = req.body;

        purchase.vendorId =
            vendorId ??
            purchase.vendorId;

        purchase.supplierInvoiceNumber =
            supplierInvoiceNumber ??
            purchase.supplierInvoiceNumber;

        purchase.purchaseDate =
            purchaseDate ??
            purchase.purchaseDate;

        purchase.paymentStatus =
            paymentStatus ??
            purchase.paymentStatus;

        purchase.paidAmount =
            paidAmount ??
            purchase.paidAmount;

        purchase.pendingAmount =
            pendingAmount ??
            purchase.pendingAmount;

        purchase.status =
            status ??
            purchase.status;

        purchase.notes =
            notes ??
            purchase.notes;

        await purchase.save();

        return successResponse(
            res,
            "Purchase updated successfully",
            purchase
        );

    } catch (error) {

        console.error(error);

        return errorResponse(
            res,
            "Failed to update purchase",
            500
        );
    }
};