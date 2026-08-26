import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import requirePermission from '../../middleware/requirePermission.js';

import { createProductController } from '../../controllers/product/createProduct.controller.js';
import { getProductsController } from '../../controllers/product/getProducts.controller.js';
import { getProductByIdController } from '../../controllers/product/getProductById.controller.js';
import { updateProductController } from '../../controllers/product/updateProduct.controller.js';
import { deleteProductController } from '../../controllers/product/deleteProduct.controller.js';
import { reactivateProductController } from '../../controllers/product/reactivateProduct.controller.js';
import { statsProductController } from '../../controllers/product/statsProduct.controller.js';
import { getProductOptionsController } from '../../controllers/product/searchProduct.controller.js';

// Read endpoints - any authenticated role (incl. STAFF) can browse products.
router.get('/options', authMiddleware, getProductOptionsController);
router.get('/stats', authMiddleware, statsProductController);
router.get('/', authMiddleware, getProductsController);
router.get('/:id', authMiddleware, getProductByIdController);

// Mutation endpoints - SUPER_ADMIN always passes; BRANCH_ADMIN/STAFF
// need the matching per-user grant (requirePermission - see
// config/permissionCatalog.js). Defaults to true for BRANCH_ADMIN and
// false for STAFF today (matching Product.createdByRole's historical
// SUPER_ADMIN/BRANCH_ADMIN-only enum, now widened to allow STAFF too),
// but a specific STAFF user can be individually granted product.create/
// product.edit/product.status - the clearest example of this system
// exceeding what a role could do before it existed.
router.post('/create', authMiddleware, requirePermission('product.create'), createProductController);
router.put('/:id', authMiddleware, requirePermission('product.edit'), updateProductController);
router.delete('/:id', authMiddleware, requirePermission('product.status'), deleteProductController);
router.patch('/:id/reactivate', authMiddleware, requirePermission('product.status'), reactivateProductController);

export default router;
