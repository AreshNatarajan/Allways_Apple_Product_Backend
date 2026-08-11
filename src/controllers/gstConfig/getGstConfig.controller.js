// controllers/gstConfig/getGstConfig.controller.js
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { SUPPORTED_CURRENCIES } from "./updateGstConfig.controller.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Bundles the supported-currency list into the same response the app
// already fetches once on load - avoids a second endpoint/request just
// to populate the currency dropdown, and keeps the option list itself
// backend-owned rather than duplicated in frontend code.
export const getGstConfigController = async (req, res) => {
    try {
        const config = await getOrCreateGstConfig();
        return successResponse(res, "GST configuration retrieved successfully", {
            ...config.toObject(),
            supportedCurrencies: SUPPORTED_CURRENCIES,
        });
    } catch (error) {
        console.error("Get GST Config Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve GST configuration", 500);
    }
};
