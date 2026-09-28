import Sale from "../../models/Sale.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// PUBLIC, unauthenticated - the customer-facing frontend's (shopping-
// commerce, /customer/:token) ONLY window into ERP data. Deliberately
// its own router/controller, never anything under authMiddleware, and
// never a passthrough of the full Sale document - see the hand-picked
// `sale` object below for exactly what a customer is allowed to see.
//
// The token IS the authorization - there is no login, no session, no
// customer/staff role check here at all. A token that doesn't resolve
// to exactly one, non-deleted Sale is treated identically to "wrong
// token" (404, generic message) - never a different error for "exists
// but wrong" vs "doesn't exist", which would leak which tokens are real.
export const getPublicSaleByTokenController = async (req, res) => {
    try {
        const { token } = req.params;
        if (!token || typeof token !== "string" || token.length < 32) {
            return errorResponse(res, "Invoice link is invalid or has expired", 404);
        }

        const sale = await Sale.findOne({ customerAccessToken: token, isDeleted: false })
            .select("saleNumber saleDate customerSnapshot customerId totalAmount paymentStatus paidAmount pendingAmount items systemInvoiceFile branchId")
            .populate("customerId", "name email")
            .populate("branchId", "name phones email")
            .lean();

        if (!sale) {
            return errorResponse(res, "Invoice link is invalid or has expired", 404);
        }

        // Snapshot-first, same convention used everywhere else in this
        // app (buildSaleInvoiceData, getInOutReport, etc.) - falls back
        // to the live Customer only when the snapshot was never stamped.
        const customer = sale.customerSnapshot?.name ? sale.customerSnapshot : (sale.customerId || {});

        const publicSale = {
            saleNumber: sale.saleNumber,
            saleDate: sale.saleDate,
            customerName: customer.name || "",
            totalAmount: sale.totalAmount || 0,
            paidAmount: sale.paidAmount || 0,
            pendingAmount: sale.pendingAmount || 0,
            paymentStatus: sale.paymentStatus,
            invoiceUrl: sale.systemInvoiceFile || null,
            branch: sale.branchId ? {
                name: sale.branchId.name,
                phone: sale.branchId.phones?.[0] || "",
            } : null,
            items: (sale.items || []).map((item) => ({
                productName: item.productName || "",
                modelNumber: item.modelNumber || "",
                // Serial number is only meaningful for a serialized line -
                // never fabricated/left as an internal batch id for a
                // non-serialized one.
                serialNumber: item.isSerialized ? (item.serialNumber || "") : "",
                quantity: item.isSerialized ? 1 : (item.quantity || 1),
                amount: item.finalAmount ?? item.itemTotal ?? item.sellingPrice ?? 0,
            })),
        };

        return successResponse(res, "Sale retrieved successfully", { sale: publicSale });
    } catch (error) {
        console.error("Get Public Sale By Token Error:", error);
        return errorResponse(res, "Failed to retrieve invoice", 500);
    }
};
