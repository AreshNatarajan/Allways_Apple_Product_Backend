import express from 'express';
const router = express.Router();

import { getPublicSaleByTokenController, downloadPublicSaleInvoiceController, resolveCustomerShortLinkController } from '../../controllers/customerAccess/getPublicSaleByToken.controller.js';
import rateLimit from '../../middleware/rateLimit.js';

// Short codes are far shorter than tokens, so their lookup is rate-
// limited per IP - a customer opens their link a handful of times.
const shortLinkLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

// PUBLIC - deliberately no authMiddleware anywhere in this router, same
// convention as routes/storefront/publicStorefront.router.js. Consumed
// by shopping-invoice (the customer invoice app), never the ERP.
// The token itself (in the URL path, never a query param that'd get
// logged in server access logs as readily) is the only credential -
// see getPublicSaleByToken.controller.js for what it does and doesn't
// authorize.
// Two segments, so it never collides with the one-segment /:token.
router.get('/s/:code', shortLinkLimit, resolveCustomerShortLinkController);
router.get('/:token', getPublicSaleByTokenController);
router.get('/:token/invoice/download', downloadPublicSaleInvoiceController);

export default router;
