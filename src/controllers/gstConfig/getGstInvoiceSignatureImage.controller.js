// controllers/gstConfig/getGstInvoiceSignatureImage.controller.js
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { errorResponse } from "../../utils/responseHandler.js";

// Streams the current invoice signature image's bytes through OUR OWN
// API - never a redirect to (or the raw URL of) the S3 object itself.
// The S3 bucket has no CORS policy, so the frontend's html2canvas step
// (which needs crossOrigin="anonymous" to read the image's pixels onto
// a canvas) gets silently blocked hitting the raw S3 URL directly, even
// though a normal <img> preview of that same URL works fine.
//
// Deliberately a plain `fetch()` of the object's public URL here, NOT
// the AWS SDK's GetObjectCommand - the app's AWS key is currently under
// AWSCompromisedKeyQuarantineV3 (confirmed live), which denies
// s3:GetObject for THAT credential entirely, regardless of bucket/key.
// But these objects are already publicly readable over plain HTTP with
// no AWS auth at all (confirmed live: 200 OK, no credentials sent) -
// which is exactly what makes them visible in a normal browser preview
// in the first place - so fetching the same public URL server-side
// sidesteps the quarantine completely; it was never an IAM permission
// this request needed.
//
// Fetching the response and converting it to a data: URI (see
// gstConfigAPI.jsx's getGstInvoiceSignatureImageDataUrlAPI) sidesteps
// the CORS problem too, since a data: URI has no cross-origin concept
// at all.
//
// Plain authMiddleware only (matches GET /gst-config itself, see
// gstConfig.router.js) - reading the signature needs no elevated
// permission, only uploading/replacing it does.
export const getGstInvoiceSignatureImageController = async (req, res) => {
    try {
        const config = await getOrCreateGstConfig();
        const url = config.invoice?.signatureImage;

        if (!url) {
            return errorResponse(res, "No invoice signature uploaded", 404);
        }

        const upstream = await fetch(url);
        if (!upstream.ok) {
            console.error("Invoice signature upstream fetch failed:", upstream.status, url);
            return errorResponse(res, "Failed to load the invoice signature", 502);
        }

        const buffer = Buffer.from(await upstream.arrayBuffer());
        res.set("Content-Type", upstream.headers.get("content-type") || "image/png");
        res.set("Cache-Control", "private, max-age=300");
        return res.send(buffer);
    } catch (error) {
        console.error("Get GST Invoice Signature Image Error:", error);
        return errorResponse(res, "Failed to load the invoice signature", 500);
    }
};
