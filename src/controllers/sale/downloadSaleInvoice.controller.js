// controllers/sale/downloadSaleInvoice.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import { errorResponse } from "../../utils/responseHandler.js";

const MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sept", "oct", "nov", "dec"];

// Same "<customer name> <month> <day>.pdf" convention as the frontend's
// own buildInvoiceFileName (generateSaleInvoicePdf.js) - duplicated here
// rather than shared, since the two run in different runtimes.
const buildInvoiceFileName = (sale) => {
    const customer = sale.customerSnapshot?.name ? sale.customerSnapshot : (sale.customerId || {});
    const rawName = (customer?.name || "invoice").trim().replace(/[\\/:*?"<>|]/g, "") || "invoice";
    const now = new Date();
    return `${rawName} ${MONTH_ABBR[now.getMonth()]} ${now.getDate()}.pdf`;
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
        res.set("Content-Disposition", `attachment; filename="${filename}"`);
        return res.send(buffer);
    } catch (error) {
        console.error("Download Sale Invoice Error:", error);
        return errorResponse(res, "Failed to download invoice", 500);
    }
};
