// config/whatsapp.js
//
// Not fail-fast at import time (unlike jwtHandler.js's JWT_SECRET
// check) - this is a new, optional integration still in test phase, so
// a missing/misconfigured WhatsApp credential should disable WhatsApp
// features specifically, not crash the whole server (which handles
// Sale/Purchase/every other unrelated feature). isWhatsAppConfigured()
// lets a caller check up front; sendWhatsAppTemplateMessage.js itself
// also throws a clear error if invoked while unconfigured, rather than
// silently failing.

export const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v22.0";
export const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
export const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN || "";
export const WHATSAPP_WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";

// Must match an APPROVED template name in Meta Business Manager - see
// controllers/productSerial/shareSerializedProductWhatsApp.controller.js
// for the exact template definition this app expects (IMAGE header +
// 6 body text params).
export const WHATSAPP_PRODUCT_SHARE_TEMPLATE_NAME =
    process.env.WHATSAPP_PRODUCT_SHARE_TEMPLATE_NAME || "serialized_product_share_v1";

export const isWhatsAppConfigured = () =>
    !!(WHATSAPP_PHONE_NUMBER_ID && WHATSAPP_API_TOKEN);

export const WHATSAPP_GRAPH_URL =
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
