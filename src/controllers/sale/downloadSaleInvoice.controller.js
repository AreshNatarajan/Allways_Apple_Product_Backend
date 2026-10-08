// controllers/sale/downloadSaleInvoice.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import { errorResponse } from "../../utils/responseHandler.js";

// Always_Apple_Products_<CustomerName>_<DD-MM-YYYY>.pdf (sale date, India
// time) - must match buildSaleInvoiceFileName in shopping-frontend's
// src/utils/invoiceFileName.js, which names the same file when it's
// downloaded right after Sale Create. Duplicated rather than shared,
// since the two run in different runtimes.
const buildInvoiceFileName = (sale) => {
    const customer = sale.customerSnapshot?.name ? sale.customerSnapshot : (sale.customerId || {});
    const safe = String(customer?.name || "")
        .trim()
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_");
    const name = safe
        ? safe.split("_").map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join("_")
        : "Customer";
    const saleDate = new Date(sale.saleDate);
    const date = (Number.isNaN(saleDate.getTime()) ? new Date() : saleDate)
        .toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata" })
        .replace(/\//g, "-");
    return `Always_Apple_Products_${name}_${date}.pdf`;
};

// Streams the invoice PDF through our own API rather than letting the
// frontend fetch() the raw S3 URL directly - same reasoning as
// getGstInvoiceSignatureImage.controller.js: the bucket has no CORS
// policy, so a cross-origin browser fetch() (needed here to control the
// downloaded file's name via Content-Disposition) is blocked, even
// though the object is already publicly readable over plain HTTP (which
// is why "View System Invoice"'s plain <a href> still works fine). Also
// why this uses a plain fetch() of the public URL, not the AWS SDK's
// GetObjectCommand - the app's AWS key is under
// AWSCompromisedKeyQuarantineV3, which denies s3:GetObject outright.
export const downloadSaleInvoiceController = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid sale ID", 400);
        }

        const sale = await Sale.findOne({ _id: id, isDeleted: false }).populate("customerId", "name");
        if (!sale) {
            return errorResponse(res, "Sale not found", 404);
        }
        if (!sale.systemInvoiceFile) {
            return errorResponse(res, "This sale has no system invoice yet", 404);
        }

        const upstream = await fetch(sale.systemInvoiceFile);
        if (!upstream.ok) {
            console.error("Invoice upstream fetch failed:", upstream.status, sale.systemInvoiceFile);
            return errorResponse(res, "Failed to load the invoice file", 502);
        }

        const buffer = Buffer.from(await upstream.arrayBuffer());
        const filename = buildInvoiceFileName(sale);

        res.set("Content-Type", "application/pdf");
        // ASCII fallback plus the UTF-8 name (RFC 5987): a non-English
        // customer name would otherwise be an invalid header value.
        const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_");
        res.set("Content-Disposition", `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        return res.send(buffer);
    } catch (error) {
        console.error("Download Sale Invoice Error:", error);
        return errorResponse(res, "Failed to download invoice", 500);
    }
};
