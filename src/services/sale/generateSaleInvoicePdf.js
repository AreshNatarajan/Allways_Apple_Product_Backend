// services/sale/generateSaleInvoicePdf.js
import crypto from "crypto";
import { PDFSaleGeneratorService } from "../../middleware/pdfGenerator.service.js";
import { putObject } from "../../controllers/fileUpload/Products/putObject.js";
import { getOrCreateGstConfig } from "../gstConfig/getOrCreateGstConfig.js";

// jsPDF can only embed an image as a data URI, never a remote URL - the
// branch's UPI QR lives in S3, so it has to be fetched and re-encoded
// before the PDF is drawn. Failure here (network hiccup, no QR set on
// the branch) must never block invoice generation - the PDF still
// generates, just without the QR box (PDFSaleGeneratorService already
// handles a missing/undefined upiQrBase64 gracefully).
const fetchImageAsBase64 = async (url) => {
    if (!url) return null;
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const arrayBuffer = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") || "image/png";
        return `data:${contentType};base64,${Buffer.from(arrayBuffer).toString("base64")}`;
    } catch (error) {
        console.error("Error fetching UPI QR image for invoice:", error);
        return null;
    }
};

// Generates the system invoice PDF for a sale (in-memory, no local disk
// write) and uploads it to S3, mirroring
// services/purchase/generatePurchaseInvoicePdf.js exactly.
//
// systemInvoiceFile is a permanent historical document once set - a sale
// is never re-invoiced, only ever invoiced once. The guard below is the
// real enforcement (not just documentation): a caller must pass a sale
// whose systemInvoiceFile is still null/unset, or this throws rather
// than silently regenerating and overwriting.
export const generateSaleInvoicePdf = async (sale) => {
    if (sale.systemInvoiceFile) {
        throw new Error(
            "This sale already has a system invoice - it cannot be regenerated or overwritten."
        );
    }

    // Read Global Settings fresh at generation time only - this PDF is
    // generated exactly once and stored permanently, so it always
    // reflects whatever the header color/currency were AT THE MOMENT of
    // this specific sale, never retroactively re-rendered later.
    const gstConfig = await getOrCreateGstConfig();
    const upiQrBase64 = await fetchImageAsBase64(sale.branchId?.upiQrImage);

    const { buffer } = await PDFSaleGeneratorService.generateSalePDF(sale, {
        headerColor: gstConfig.invoice.headerColor,
        currencyCode: gstConfig.currency.code,
        upiQrBase64,
    });

    const uniqueKey = `sales/invoices/${sale.saleNumber || "sale"}-${Date.now()}-${crypto
        .randomBytes(6)
        .toString("hex")}.pdf`;

    const { url, key } = await putObject(buffer, uniqueKey, "application/pdf");

    return { url, key };
};
