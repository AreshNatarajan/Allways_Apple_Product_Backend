// services/whatsapp/sendWhatsAppTemplateMessage.js
import { WHATSAPP_GRAPH_URL, WHATSAPP_API_TOKEN, isWhatsAppConfigured } from "../../config/whatsapp.js";

// WhatsApp Cloud API expects digits only, no "+", no spaces/dashes,
// country code included (e.g. "916383036186") - never trusts whatever
// format a phone number happens to be stored in elsewhere in this app.
export const normalizeWhatsAppPhone = (phone) => (phone || "").replace(/[^\d]/g, "");

/**
 * Sends a WhatsApp template message via the Graph API. Template
 * messages are the only message type that can be sent outside an
 * active 24-hour customer-service session, and the template itself
 * must already exist and be APPROVED in Meta Business Manager - this
 * function only ever references a template by name, it never creates
 * or edits one (that's a one-time manual step on Meta's dashboard).
 *
 * `components` is passed through verbatim to match the Graph API's own
 * template-components schema exactly (header/body/button parameters) -
 * see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
 * Callers build this array themselves rather than this function trying
 * to guess a shape that fits every possible template.
 */
export const sendWhatsAppTemplateMessage = async ({
    to,
    templateName,
    languageCode = "en_US",
    components = [],
}) => {
    if (!isWhatsAppConfigured()) {
        throw new Error(
            "WhatsApp is not configured - set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_API_TOKEN in .env"
        );
    }
    if (!to) throw new Error("Recipient phone number is required");
    if (!templateName) throw new Error("Template name is required");

    const normalizedTo = normalizeWhatsAppPhone(to);
    if (!normalizedTo) throw new Error("Recipient phone number is invalid");

    const payload = {
        messaging_product: "whatsapp",
        to: normalizedTo,
        type: "template",
        template: {
            name: templateName,
            language: { code: languageCode },
            ...(components.length > 0 ? { components } : {}),
        },
    };

    const response = await fetch(WHATSAPP_GRAPH_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
        // Meta's error shape is {error: {message, type, code, ...}} -
        // surface its real message rather than a generic "request
        // failed", since it's usually the most useful diagnostic (e.g.
        // "template not found", "recipient phone number not in
        // allowed list" for a test-mode app).
        const message = data?.error?.message || `WhatsApp API request failed (${response.status})`;
        const error = new Error(message);
        error.whatsappError = data?.error || null;
        error.statusCode = response.status;
        throw error;
    }

    return data;
};
