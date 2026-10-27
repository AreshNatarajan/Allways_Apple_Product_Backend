import express from 'express';
const router = express.Router();

import { productSharePageController, productSharePreviewImageController } from '../../controllers/storefront/productShare.controller.js';
import rateLimit from '../../middleware/rateLimit.js';

// PUBLIC - shared storefront product links (/p/:id) and their preview
// image. No authMiddleware, same as publicStorefront.router.js. The
// image route resizes a photo, so it gets the tighter limit.
const pageLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 120 });
const imageLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });

router.get('/:id', pageLimit, productSharePageController);
router.get('/:id/preview-:version.jpg', imageLimit, productSharePreviewImageController);

export default router;
