// controllers/gstConfig/updateGstConfig.controller.js
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const HEX_COLOR_REGEX = /^#([0-9A-F]{3}|[0-9A-F]{6})$/;
// Prefixes feed straight into the document-number format
// "<PREFIX>-<YYYYMM>-<seq>" (see services/documentNumber.service.js) -
// only letters/digits are allowed so a prefix can never itself inject
// an extra "-" or produce a malformed/ambiguous document number.
const PREFIX_REGEX = /^[A-Z0-9]{1,10}$/;

// Server is the single source of truth for code->symbol - the client
// only ever sends a currency code, never a symbol, so a tampered/stale
// symbol can never get stored.
export const SUPPORTED_CURRENCIES = [
    { code: "INR", symbol: "₹", label: "Indian Rupee" },
    { code: "USD", symbol: "$", label: "US Dollar" },
    { code: "EUR", symbol: "€", label: "Euro" },
    { code: "GBP", symbol: "£", label: "British Pound" },
    { code: "AED", symbol: "د.إ", label: "UAE Dirham" },
];

// SUPER_ADMIN only (see gstConfig.router.js) - GST rates/global app
// settings are company-wide, not a per-branch choice. Editing
// this NEVER touches any existing Purchase/Sale/Transfer/ProductSerial/
// Batch/BatchStock document - every one of those already captured its
// own permanent snapshot (document number, GST rate, etc) at the moment
// of that transaction; only NEW documents ever read this config again.
export const updateGstConfigController = async (req, res) => {
    try {
        const {
            invoiceSettings,
            availableGstRates,
            marginSchemeRate,
            standardRate,
            currency,
            documentPrefixes,
            inventory,
            invoice,
        } = req.body;

        if (marginSchemeRate !== undefined && (Number(marginSchemeRate) < 0 || Number(marginSchemeRate) > 100)) {
            return errorResponse(res, "Margin scheme rate must be between 0 and 100", 400);
        }

        if (standardRate !== undefined && (Number(standardRate) < 0 || Number(standardRate) > 100)) {
            return errorResponse(res, "Standard rate must be between 0 and 100", 400);
        }

        if (availableGstRates !== undefined && !Array.isArray(availableGstRates)) {
            return errorResponse(res, "Available GST rates must be an array of numbers", 400);
        }

        let resolvedCurrency;
        if (currency !== undefined) {
            const code = (currency.code || "").trim().toUpperCase();
            resolvedCurrency = SUPPORTED_CURRENCIES.find((c) => c.code === code);
            if (!resolvedCurrency) {
                return errorResponse(res, `Unsupported currency code. Supported: ${SUPPORTED_CURRENCIES.map((c) => c.code).join(", ")}`, 400);
            }
        }

        let resolvedPrefixes;
        if (documentPrefixes !== undefined) {
            resolvedPrefixes = {};
            for (const key of ["purchase", "sale", "transfer"]) {
                const raw = (documentPrefixes[key] || "").trim().toUpperCase();
                if (!raw || !PREFIX_REGEX.test(raw)) {
                    return errorResponse(res, `${key[0].toUpperCase()}${key.slice(1)} prefix must be 1-10 letters/digits only`, 400);
                }
                resolvedPrefixes[key] = raw;
            }
        }

        let resolvedInventory;
        if (inventory !== undefined) {
            resolvedInventory = {};
            for (const key of ["serializedLowStockThreshold", "nonSerializedLowStockThreshold"]) {
                const raw = inventory[key];
                const num = Number(raw);
                if (raw === undefined || raw === null || raw === "" || !Number.isInteger(num) || num < 0) {
                    return errorResponse(res, `${key} must be a whole number >= 0`, 400);
                }
                resolvedInventory[key] = num;
            }
        }

        let resolvedInvoice;
        if (invoice !== undefined) {
            const headerColor = (invoice.headerColor || "").trim().toUpperCase();
            if (!HEX_COLOR_REGEX.test(headerColor)) {
                return errorResponse(res, "Invoice header color must be a valid hex color (e.g. #1E3C96)", 400);
            }
            resolvedInvoice = { headerColor };
        }

        const config = await getOrCreateGstConfig();

        if (invoiceSettings !== undefined) {
            config.invoiceSettings = {
                footerNote: invoiceSettings.footerNote?.trim() || "",
                termsAndConditions: invoiceSettings.termsAndConditions?.trim() || "",
            };
        }
        if (availableGstRates !== undefined) {
            config.availableGstRates = availableGstRates.map((r) => Number(r) || 0);
        }
        if (marginSchemeRate !== undefined) config.marginSchemeRate = Number(marginSchemeRate);
        if (standardRate !== undefined) config.standardRate = Number(standardRate);
        if (resolvedCurrency) config.currency = { code: resolvedCurrency.code, symbol: resolvedCurrency.symbol };
        if (resolvedPrefixes) config.documentPrefixes = resolvedPrefixes;
        if (resolvedInventory) config.inventory = resolvedInventory;
        if (resolvedInvoice) config.invoice = resolvedInvoice;

        config.updatedBy = req.user._id;

        await config.save();

        return successResponse(res, "Global settings updated successfully", config);
    } catch (error) {
        console.error("Update GST Config Error:", error);
        return errorResponse(res, error.message || "Failed to update global settings", 500);
    }
};
