// models/WhatsAppMessageLog.model.js
import mongoose from "mongoose";

// Minimal send/receive trail for debugging the WhatsApp integration
// while it's being built out - not a full message-thread/CRM feature.
// One row per outbound send attempt, later updated with delivery-status
// events reported by the webhook (matched via whatsappMessageId).
const whatsAppMessageLogSchema = new mongoose.Schema(
    {
        direction: {
            type: String,
            enum: ["OUTBOUND", "INBOUND"],
            required: true,
        },

        to: { type: String, default: "" },
        from: { type: String, default: "" },

        templateName: { type: String, default: "" },

        // The id Meta assigns to this specific message (returned in the
        // send response, or present on inbound/status webhook payloads)
        // - the join key between an OUTBOUND log row and its later
        // status updates.
        whatsappMessageId: { type: String, default: "", index: true },

        // "sent" | "delivered" | "read" | "failed" (outbound) - webhook
        // status events update this on the matching row, never create a
        // new row per status change.
        status: { type: String, default: "" },

        // Loosely typed - the exact context differs per use (e.g.
        // {context: "inventory-serial-share", serialNumber, sentBy}),
        // never structured business data that belongs on a real model.
        meta: { type: mongoose.Schema.Types.Mixed, default: {} },

        // Raw Graph API response / webhook payload, kept for debugging -
        // never parsed elsewhere, purely a debugging aid.
        rawPayload: { type: mongoose.Schema.Types.Mixed, default: null },

        errorMessage: { type: String, default: "" },
    },
    { timestamps: true }
);

whatsAppMessageLogSchema.index({ createdAt: -1 });

const WhatsAppMessageLog = mongoose.model("WhatsAppMessageLog", whatsAppMessageLogSchema);

export default WhatsAppMessageLog;
