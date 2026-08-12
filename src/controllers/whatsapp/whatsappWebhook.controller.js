// controllers/whatsapp/whatsappWebhook.controller.js
import { WHATSAPP_WEBHOOK_VERIFY_TOKEN } from "../../config/whatsapp.js";
import WhatsAppMessageLog from "../../models/WhatsAppMessageLog.model.js";

// Meta's one-time handshake when you save the webhook URL in App
// Dashboard > WhatsApp > Configuration: it GETs this URL with
// hub.mode=subscribe, hub.verify_token=<whatever you typed there>, and
// hub.challenge=<random string>. Respond with hub.challenge as plain
// text if the verify token matches, or Meta refuses to save the
// webhook. This route is intentionally NOT behind authMiddleware -
// Meta's server calls it directly, with no user session.
export const verifyWhatsAppWebhookController = (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token && WHATSAPP_WEBHOOK_VERIFY_TOKEN && token === WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
};

// Meta POSTs every inbound message AND every delivery-status update
// (sent/delivered/read/failed) for messages we sent to this same URL -
// there's no separate endpoint per event type, the payload shape tells
// them apart (statuses[] vs messages[]). For now this just logs each
// event for visibility/debugging - no business logic reacts to these
// yet (that's for the later "implement all place" phase).
export const receiveWhatsAppWebhookController = async (req, res) => {
    // Meta requires a fast 200 response regardless of what's inside -
    // it retries with backoff on anything else, which would otherwise
    // duplicate-deliver the same event. Acknowledge first, process after.
    res.sendStatus(200);

    try {
        const entry = req.body?.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        if (!value) return;

        // Delivery-status update for a message we sent - update the
        // matching OUTBOUND log row rather than creating a new one.
        for (const statusEvent of value.statuses || []) {
            await WhatsAppMessageLog.updateOne(
                { whatsappMessageId: statusEvent.id },
                {
                    $set: {
                        status: statusEvent.status,
                        errorMessage: statusEvent.errors?.[0]?.title || "",
                    },
                    $push: { "meta.statusHistory": { status: statusEvent.status, at: statusEvent.timestamp } },
                }
            );
        }

        // Inbound message from a customer.
        for (const message of value.messages || []) {
            await WhatsAppMessageLog.create({
                direction: "INBOUND",
                from: message.from || "",
                whatsappMessageId: message.id || "",
                status: "received",
                rawPayload: message,
            });
        }
    } catch (error) {
        // Never let a logging failure surface to Meta - it already got
        // its 200 above, this is purely our own visibility.
        console.error("WhatsApp Webhook Processing Error:", error);
    }
};
