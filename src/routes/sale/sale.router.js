import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import onlySuperAdmin from '../../middleware/onlySuperAdmin.js';

// 1. Import the controller function
import { createSaleController } from '../../controllers/sale/createSale.controller.js';
import { getSaleByIdController } from '../../controllers/sale/getSaleById.controller.js';
import { getAllSalesController } from '../../controllers/sale/getAllSales.controller.js';
import { uploadSaleSelfieController } from '../../controllers/sale/uploadSaleSelfie.controller.js';
import { reviewSaleController } from '../../controllers/sale/reviewSale.controller.js';

import { statsSaleController } from '../../controllers/sale/statsSale.controller.js'

import { searchPurchasedProductWithSerialNumber } from '../../controllers/sale/searchPurchasedProductWithSerialNumber.js';


import { getAvailableProductsController } from '../../controllers/sale/getAvailableProducts.controller.js'

import { getScannerBarcodeByAvailableProductController } from '../../controllers/sale/getScannerBarcodeByAvailableProductController.js';


router.get(
    '/scanner/:barcodeValue',
    authMiddleware,
    getScannerBarcodeByAvailableProductController
);

// Route for searching purchased products with serial number
router.get('/available-products', authMiddleware, getAvailableProductsController);

// Route for getting sales statistics

router.get('/stats', authMiddleware, statsSaleController);

// Add route for getting all sales
router.get('/', authMiddleware, getAllSalesController); 

// Accountability selfie - any authenticated role may call this (the
// "non-SUPER_ADMIN sales only" rule is enforced in
// createSale.controller.js, not here).
router.post('/upload-selfie', authMiddleware, uploadSaleSelfieController);

// EOD review - `/:id/review` is more specific than the generic `GET
// /:id` below, but still kept ahead of it for clarity/consistency.
router.patch('/:id/review', authMiddleware, onlySuperAdmin, reviewSaleController);

// Add route for getting sale by ID
router.get('/:id', authMiddleware, getSaleByIdController);

// 2. Change the route handler to use the imported controller

router.post('/create', authMiddleware, createSaleController);



export default router;  