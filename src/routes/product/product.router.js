import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import onlyAdminRoles from '../../middleware/onlyAdminRoles.js';

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

// Mutation endpoints - SUPER_ADMIN / BRANCH_ADMIN only (matches
// Product.createdByRole, which never allowed STAFF as an author).
router.post('/create', authMiddleware, onlyAdminRoles, createProductController);
router.put('/:id', authMiddleware, onlyAdminRoles, updateProductController);
router.delete('/:id', authMiddleware, onlyAdminRoles, deleteProductController);
router.patch('/:id/reactivate', authMiddleware, onlyAdminRoles, reactivateProductController);

export default router;
