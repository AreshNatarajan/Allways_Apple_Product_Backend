// controllers/productSerial/shareSerializedProductWhatsApp.controller.js
import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import WhatsAppMessageLog from "../../models/WhatsAppMessageLog.model.js";
import { sendWhatsAppTemplateMessage, normalizeWhatsAppPhone } from "../../services/whatsapp/sendWhatsAppTemplateMessage.js";
import { WHATSAPP_PRODUCT_SHARE_TEMPLATE_NAME } from "../../config/whatsapp.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

/**
 * TEMPLATE THIS CONTROLLER EXPECTS (create + get this approved in Meta
 * Business Manager > WhatsApp Manager > Message Templates before this
 * will actually deliver - sending against an unapproved/nonexistent
 * template name fails with a clear Meta error, surfaced as-is below):
 *
 *   Name:     serialized_product_share_v1 (or whatever
 *             WHATSAPP_PRODUCT_SHARE_TEMPLATE_NAME is set to)
 *   Category: UTILITY (this is a direct response about a specific item
 *             a staff member is sharing with a specific customer, not
 *             a bulk marketing broadcast - Meta's review may reclassify
 *             it, that's their call)
 *   Language: en_US
 *   Header:   IMAGE (dynamic - this unit's own photo)
 *   Body:
 *     Hi! Here are the details of the item you asked about:
 *
 *     Product: {{1}}
 *     Model: {{2}}
 *     Serial No: {{3}}
 *
 *     {{4}}
 *
 *     Available at: {{5}}
 *     Location: {{6}}
 *   Footer:   (optional, static) "Reply to this message for any questions."
 *
 * Params sent, in order: productName, modelNumber, serialNumber,
 * description (or a fallback string if empty), branchName, branch
 * Google Maps URL (plain text - WhatsApp auto-links it in the body).
 */
export const shareSerializedProductWhatsAppController = async (req, res) => {
    try {
        const { id } = req.params;
        const { phone } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid serial ID", 400);
        }
        if (!phone || !normalizeWhatsAppPhone(phone)) {
            return errorResponse(res, "A valid recipient phone number is required", 400);
        }

        const serial = await ProductSerial.findOne({ _id: id, isDeleted: false })
            .populate("productId", "name modelNumber")
            .populate("currentBranchId", "name googleMapUrl");

        if (!serial) {
            return errorResponse(res, "Serial not found", 404);
        }

        // This exact unit's own photo - never a generic Product-level
        // image (see ProductSerial.modal.js/Product.modal.js's ownership
        // rule). The template's header is defined as IMAGE, so there
        // must be one to send against it at all.
        const headerImageUrl = serial.images?.[0]?.url;
        if (!headerImageUrl) {
            return errorResponse(
                res,
                "This serial has no photo yet - add at least one image before sharing on WhatsApp",
                400
            );
        }

        const branch = serial.currentBranchId;
        if (!branch?.googleMapUrl) {
            return errorResponse(
                res,
                "This serial's current branch has no Google Maps location set - add one in Branch settings before sharing",
                400
            );
        }

        const productName = serial.productId?.name || "Product";
        const modelNumber = serial.modelNumber || serial.productId?.modelNumber || "-";
        const description = serial.description?.trim() || "No additional notes.";

        const components = [
            { type: "header", parameters: [{ type: "image", image: { link: headerImageUrl } }] },
            {
                type: "body",
                parameters: [
                    { type: "text", text: productName },
                    { type: "text", text: modelNumber },
                    { type: "text", text: serial.serialNumber },
                    { type: "text", text: description },
                    { type: "text", text: branch.name || "-" },
                    { type: "text", text: branch.googleMapUrl },
                ],
            },
        ];

        const logRow = await WhatsAppMessageLog.create({
            direction: "OUTBOUND",
            to: normalizeWhatsAppPhone(phone),
            templateName: WHATSAPP_PRODUCT_SHARE_TEMPLATE_NAME,
            status: "sending",
            meta: { context: "inventory-serial-share", serialNumber: serial.serialNumber, sentBy: req.user?._id },
        });

        try {
            const result = await sendWhatsAppTemplateMessage({
                to: phone,
                templateName: WHATSAPP_PRODUCT_SHARE_TEMPLATE_NAME,
                languageCode: "en_US",
                components,
            });

            logRow.whatsappMessageId = result?.messages?.[0]?.id || "";
            logRow.status = "sent";
            logRow.rawPayload = result;
            await logRow.save();

            return successResponse(res, "Shared on WhatsApp successfully", {
                whatsappMessageId: logRow.whatsappMessageId,
            });
        } catch (sendError) {
            logRow.status = "failed";
            logRow.errorMessage = sendError.message;
            logRow.rawPayload = sendError.whatsappError || null;
            await logRow.save();
            throw sendError;
        }
    } catch (error) {
        console.error("Share Serialized Product WhatsApp Error:", error);
        return errorResponse(res, error.message || "Failed to share on WhatsApp", 500);
    }
};
