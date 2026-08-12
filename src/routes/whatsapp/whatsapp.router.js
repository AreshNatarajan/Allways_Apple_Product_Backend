import express from 'express';
const router = express.Router();

import {
    verifyWhatsAppWebhookController,
    receiveWhatsAppWebhookController,
} from '../../controllers/whatsapp/whatsappWebhook.controller.js';

// No authMiddleware on either route - Meta's servers call these
// directly (webhook verification handshake + event delivery), there is
// no user session to check. The verify-token check inside
// verifyWhatsAppWebhookController is the real security boundary for
// the GET route; the POST route only ever writes to our own
// WhatsAppMessageLog, never trusted for anything sensitive.
router.get('/webhook', verifyWhatsAppWebhookController);
router.post('/webhook', receiveWhatsAppWebhookController);

export default router;
