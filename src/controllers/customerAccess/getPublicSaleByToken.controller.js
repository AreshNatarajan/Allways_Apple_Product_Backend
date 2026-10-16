import Sale from "../../models/Sale.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { sendSaleInvoicePdf } from "../sale/downloadSaleInvoice.controller.js";

const isWellFormedToken = (token) => !!token && typeof token === "string" && token.length >= 32;

// PUBLIC, unauthenticated - the customer invoice app's (shopping-invoice,
// /invoice/:token) ONLY window into ERP data. Deliberately
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
        if (!isWellFormedToken(token)) {
            return errorResponse(res, "Invoice link is invalid or has expired", 404);
        }

        const sale = await Sale.findOne({ customerAccessToken: token, isDeleted: false })
            .select("saleDate customerSnapshot customerId totalAmount convenienceFee paymentStatus paidAmount pendingAmount items systemInvoiceFile branchId")
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
            // No saleNumber - the invoice number is internal; customers don't see it.
            saleDate: sale.saleDate,
            customerName: customer.name || "",
            // What the customer pays: products + any card convenience fee
            // (see services/sale/cardCharges.js) - the fee is paid with
            // the card payment itself, so it counts as paid too.
            convenienceFee: sale.convenienceFee || 0,
            totalAmount: (sale.totalAmount || 0) + (sale.convenienceFee || 0),
            paidAmount: (sale.paidAmount || 0) + (sale.convenienceFee || 0),
            pendingAmount: sale.pendingAmount || 0,
            paymentStatus: sale.paymentStatus,
            invoiceUrl: sale.systemInvoiceFile || null,
            // The download itself goes through downloadPublicSaleInvoiceController
            // below (S3 has no CORS and can't set the file name).
            hasInvoice: !!sale.systemInvoiceFile,
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

// PUBLIC - the customer's "Download invoice" button. Same token rule as
// above (the token is the only credential, and every miss is the same
// generic 404), same PDF and file name as the ERP's own download.
export const downloadPublicSaleInvoiceController = async (req, res) => {
    try {
        const { token } = req.params;
        if (!isWellFormedToken(token)) {
            return errorResponse(res, "Invoice link is invalid or has expired", 404);
        }

        const sale = await Sale.findOne({ customerAccessToken: token, isDeleted: false })
            .select("saleDate customerSnapshot customerId systemInvoiceFile")
            .populate("customerId", "name");
        if (!sale) {
            return errorResponse(res, "Invoice link is invalid or has expired", 404);
        }

        return await sendSaleInvoicePdf(res, sale);
    } catch (error) {
        console.error("Download Public Sale Invoice Error:", error);
        return errorResponse(res, "Failed to download invoice", 500);
    }
};
