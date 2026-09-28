import express from 'express';
const router = express.Router();

import { getPublicSaleByTokenController } from '../../controllers/customerAccess/getPublicSaleByToken.controller.js';

// PUBLIC - deliberately no authMiddleware anywhere in this router, same
// convention as routes/storefront/publicStorefront.router.js. Consumed
// by shopping-commerce (the customer-facing frontend), never the ERP.
// The token itself (in the URL path, never a query param that'd get
// logged in server access logs as readily) is the only credential -
// see getPublicSaleByToken.controller.js for what it does and doesn't
// authorize.
router.get('/:token', getPublicSaleByTokenController);

export default router;
