// services/purchase/generatePurchaseInvoicePdf.js
import crypto from "crypto";
import PDFPurchaseGeneratorService from "../../middleware/pdfGenerator.service.js";
import { putObject } from "../../controllers/fileUpload/Products/putObject.js";
import { getOrCreateGstConfig } from "../gstConfig/getOrCreateGstConfig.js";

// Generates the system invoice PDF for a purchase (in-memory, no local
// disk write) and uploads it to S3 under a unique key, reusing the same
// putObject helper already used by branch logo / profile image / product
// image uploads elsewhere in this app.
//
// systemInvoiceFile is a permanent historical document once set - a
// purchase is never re-invoiced, only ever invoiced once. The guard
// below is the real enforcement (not just documentation): a caller must
// pass a purchase whose systemInvoiceFile is still null/unset, or this
// throws rather than silently regenerating and overwriting.
export const generatePurchaseInvoicePdf = async (purchase) => {
    if (purchase.systemInvoiceFile) {
        throw new Error(
            "This purchase already has a system invoice - it cannot be regenerated or overwritten."
        );
    }

    // Read Global Settings fresh at generation time only - this PDF is
    // generated exactly once and stored permanently, so it always
    // reflects whatever the header color/currency were AT THE MOMENT of
    // this specific purchase, never retroactively re-rendered later.
    const gstConfig = await getOrCreateGstConfig();
    const { buffer } = await PDFPurchaseGeneratorService.generatePurchasePDF(purchase, {
        headerColor: gstConfig.invoice.headerColor,
        currencyCode: gstConfig.currency.code,
    });

    const uniqueKey = `purchases/invoices/${purchase.purchaseNumber || "purchase"}-${Date.now()}-${crypto
        .randomBytes(6)
        .toString("hex")}.pdf`;

    const { url, key } = await putObject(buffer, uniqueKey, "application/pdf");

    return { url, key };
};
