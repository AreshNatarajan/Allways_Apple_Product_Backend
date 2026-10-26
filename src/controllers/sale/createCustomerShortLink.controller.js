// controllers/sale/createCustomerShortLink.controller.js
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { buildShortLink } from "../../config/customerApp.js";
import { getOrCreateSaleShortCode, ShortLinkError } from "../../services/sale/customerShortLink.js";

// POST /sale/:id/customer-short-link - Sale Detail's "Copy Message".
// Same access as the full link it shortens: getSaleById already hands
// `customerLink` to anyone who passes authMiddleware + requireSaleBranch,
// and this route sits behind exactly those two. Takes no body - the
// destination is always this sale's own invoice, never client-supplied.
// Idempotent: every call for the same sale returns the same link.
export const createCustomerShortLinkController = async (req, res) => {
    try {
        const code = await getOrCreateSaleShortCode(req.params.id);
        return successResponse(res, "Short invoice link ready", { shortLink: buildShortLink(code) });
    } catch (error) {
        if (error instanceof ShortLinkError) {
            return errorResponse(res, error.message, error.status);
        }
        // Message only - never the sale document, token or link.
        console.error("Create Customer Short Link Error:", error?.message);
        return errorResponse(res, "Could not create a short invoice link - please try again.", 500);
    }
};
