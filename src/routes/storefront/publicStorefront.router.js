import express from 'express';
const router = express.Router();

import { getPublicStorefrontProductsController } from '../../controllers/storefront/getPublicStorefrontProducts.controller.js';
import { getPublicStorefrontProductByIdController } from '../../controllers/storefront/getPublicStorefrontProductById.controller.js';
import { getPublicStorefrontCategoriesController } from '../../controllers/storefront/getPublicStorefrontCategories.controller.js';
import { getPublicStorefrontBranchesController } from '../../controllers/storefront/getPublicStorefrontBranches.controller.js';

// PUBLIC - deliberately no authMiddleware anywhere in this router. The
// only routes in this whole backend meant to be reachable without a
// staff login, consumed by shopping-commerce (the customer-facing
// storefront). Sourced live from real branch inventory
// (ProductSerial, status:AVAILABLE, serialized only) across every
// branch - see getPublicStorefrontProducts.controller.js's own comment.
// Never exposes purchasePrice/GST/vendor/branch-contact-detail data -
// only what's already safe to show a customer.
router.get('/products', getPublicStorefrontProductsController);
router.get('/products/:id', getPublicStorefrontProductByIdController);
router.get('/categories', getPublicStorefrontCategoriesController);
router.get('/branches', getPublicStorefrontBranchesController);

export default router;
