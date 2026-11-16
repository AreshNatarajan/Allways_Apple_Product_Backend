// controllers/sale/lookupShowroomExchangeUnit.controller.js
//
// Read-only lookup for Sale Create's "showroom product" exchange row:
// staff type a serial number and see whether it is one of OUR previously
// sold units that can be taken back. Runs the exact same server-side
// validation the sale submit re-runs (resolveShowroomUnit), so the UI can
// never offer a unit the submit would reject for a static reason.
//
// Deliberately not branch-scoped to the original sale: a customer may
// return at a different branch than they bought from (the unit is
// received by the NEW sale's branch). Cost fields are never returned.
import { resolveShowroomUnit } from "../../services/sale/showroomExchangeProcessor.service.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const lookupShowroomExchangeUnitController = async (req, res) => {
    try {
        const { serialNumber } = req.params;
        if (!serialNumber || !serialNumber.trim()) {
            return errorResponse(res, "Serial number is required", 400);
        }

        const r = await resolveShowroomUnit({ serialNumber });
        if (r.error) return errorResponse(res, r.error, 400);

        const { serial, originalSale, line } = r.unit;
        return successResponse(res, "Replacement unit found", {
            productId: serial.productId,
            serialNumber: serial.serialNumber,
            productName: line.productName,
            modelNumber: line.modelNumber,
            originalSaleId: originalSale._id,
            originalSaleNumber: originalSale.saleNumber,
            originalBranchId: originalSale.branchId || null,
            originalSoldAt: serial.soldAt || originalSale.saleDate || null,
            originalCustomerName: originalSale.customerSnapshot?.name || "",
            originalSellingPrice: line.sellingPrice,
            originalFinalAmount: line.finalAmount,
        });
    } catch (error) {
        console.error("Lookup Showroom Exchange Unit Error:", error);
        return errorResponse(res, error.message || "Failed to look up unit", 500);
    }
};
