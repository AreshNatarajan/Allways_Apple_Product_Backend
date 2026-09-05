import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import requirePermission from '../../middleware/requirePermission.js';

import { getStorefrontProductsAdminController } from '../../controllers/storefront/getStorefrontProductsAdmin.controller.js';
import { upsertStorefrontProductController } from '../../controllers/storefront/upsertStorefrontProduct.controller.js';
import { deleteStorefrontProductController } from '../../controllers/storefront/deleteStorefrontProduct.controller.js';
import { uploadStorefrontImageController } from '../../controllers/storefront/uploadStorefrontImage.controller.js';

// Staff-side "Online Catalog" management - read is open to any
// authenticated role (same as Products/Vendors elsewhere), writes need
// the storefront.manage grant (defaults to true for BRANCH_ADMIN, false
// for STAFF - see config/permissionCatalog.js - curating the public
// catalog is treated as a more sensitive action than everyday sale/
// purchase entry). SUPER_ADMIN always passes via requirePermission.
router.get('/products', authMiddleware, getStorefrontProductsAdminController);
router.put('/products/:productId', authMiddleware, requirePermission('storefront.manage'), upsertStorefrontProductController);
router.delete('/products/:id', authMiddleware, requirePermission('storefront.manage'), deleteStorefrontProductController);
router.post('/upload-image', authMiddleware, requirePermission('storefront.manage'), uploadStorefrontImageController);

export default router;
