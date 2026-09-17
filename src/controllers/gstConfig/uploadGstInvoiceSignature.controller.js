// controllers/gstConfig/uploadGstInvoiceSignature.controller.js
import crypto from "crypto";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { resolveImageExtension } from "../../middleware/uploadUserImage.middleware.js";
import { convertImageForStorage } from "../../services/image/convertImageForStorage.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { deleteObject } from "../fileUpload/Products/deleteObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

// SUPER_ADMIN only (see gstConfig.router.js) - the one company-wide
// signature shown on every NEW Sale invoice (see Invoice.jsx), same
// "current settings, not a frozen snapshot" story headerColor already
// has: replacing it here only affects invoices generated from this
// point on, never rewrites an already-issued PDF sitting in S3.
//
// PNG only, deliberately narrower than the general image-upload
// allowlist (validateImageFile) - a signature needs a transparent
// background to composite cleanly onto the invoice's white page; a
// JPEG upload would carry an opaque (often white or black) background
// and paint a visible box around the signature instead.
export const uploadGstInvoiceSignatureController = async (req, res) => {
    try {
        const file = req.files?.image;

        if (!file) {
            return errorResponse(res, "No image file uploaded", 400);
        }
        if (file.mimetype !== "image/png") {
            return errorResponse(res, "Signature must be a PNG image (needs a transparent background)", 400);
        }
        if (file.size > MAX_IMAGE_SIZE_BYTES) {
            return errorResponse(res, "Image must be 5MB or smaller", 400);
        }

        const config = await getOrCreateGstConfig();

        let converted;
        try {
            // Lossless PNG re-encode only (see convertImageForStorage) -
            // resize/recompress is safe and beneficial here, unlike a UPI
            // QR code, since a signature doesn't need to stay pixel-exact.
            converted = await convertImageForStorage(file, resolveImageExtension(file));
        } catch (conversionError) {
            console.error("Signature image conversion error:", conversionError);
            return errorResponse(res, "Could not process this image - the file may be corrupted", 400);
        }

        const storageKey = `settings/invoice-signature/${Date.now()}-${crypto
            .randomBytes(6)
            .toString("hex")}.${converted.extension}`;

        const { url, key } = await putObject(converted.data, storageKey, converted.mimetype);

        const previousKey = config.invoice.signatureImageKey;

        config.invoice.signatureImage = url;
        config.invoice.signatureImageKey = key;
        config.updatedBy = req.user._id;
        await config.save();

        if (previousKey) {
            try {
                await deleteObject(previousKey);
            } catch (cleanupError) {
                console.error("Old invoice signature cleanup failed:", cleanupError);
            }
        }

        return successResponse(res, "Invoice signature updated successfully", {
            signatureImage: config.invoice.signatureImage,
        });
    } catch (error) {
        console.error("Upload GST Invoice Signature Error:", error);
        return errorResponse(res, "Server error while uploading the invoice signature", 500);
    }
};
