import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import onlySuperAdmin from '../../middleware/onlySuperAdmin.js';
import onlyBranchRoles from '../../middleware/onlyBranchRoles.js';

// 1. Import the controller function
import { createSaleController } from '../../controllers/sale/createSale.controller.js';
import { updateSaleController } from '../../controllers/sale/updateSale.controller.js';
import { getSaleByIdController } from '../../controllers/sale/getSaleById.controller.js';
import { getAllSalesController } from '../../controllers/sale/getAllSales.controller.js';
import { uploadSaleSelfieController } from '../../controllers/sale/uploadSaleSelfie.controller.js';
import { reviewSaleController } from '../../controllers/sale/reviewSale.controller.js';

import { statsSaleController } from '../../controllers/sale/statsSale.controller.js'

import { searchPurchasedProductWithSerialNumber } from '../../controllers/sale/searchPurchasedProductWithSerialNumber.js';


import { getAvailableProductsController } from '../../controllers/sale/getAvailableProducts.controller.js'

import { getScannerBarcodeByAvailableProductController } from '../../controllers/sale/getScannerBarcodeByAvailableProductController.js';


// Sale creation is BRANCH_ADMIN / STAFF only (onlyBranchRoles) -
// SUPER_ADMIN keeps full read access below (list/detail/stats, for
// oversight and EOD review) but is explicitly blocked from every
// creation-flow endpoint, rather than only failing implicitly once
// they hit the branchId-required check deeper in the controller.
router.get(
    '/scanner/:barcodeValue',
    authMiddleware,
    onlyBranchRoles,
    getScannerBarcodeByAvailableProductController
);

// Route for searching purchased products with serial number
router.get('/available-products', authMiddleware, onlyBranchRoles, getAvailableProductsController);

// Route for getting sales statistics

router.get('/stats', authMiddleware, statsSaleController);

// Add route for getting all sales
router.get('/', authMiddleware, getAllSalesController);

// Accountability selfie - part of the sale-creation flow, same
// BRANCH_ADMIN/STAFF-only gate as the rest of it.
router.post('/upload-selfie', authMiddleware, onlyBranchRoles, uploadSaleSelfieController);

// EOD review - `/:id/review` is more specific than the generic `GET
// /:id` below, but still kept ahead of it for clarity/consistency.
router.patch('/:id/review', authMiddleware, onlySuperAdmin, reviewSaleController);

// Add route for getting sale by ID
router.get('/:id', authMiddleware, getSaleByIdController);

// 2. Change the route handler to use the imported controller

router.post('/create', authMiddleware, onlyBranchRoles, createSaleController);

// Sale Edit - no role gate (all three roles can edit, mirrors Purchase's
// identical PUT /:id); updateSaleController resets EOD review for a
// non-SUPER_ADMIN editor and clears it for a SUPER_ADMIN editor itself.
router.put('/:id', authMiddleware, updateSaleController);

export default router;