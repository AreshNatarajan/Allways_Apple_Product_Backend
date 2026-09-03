import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import onlySuperAdmin from '../../middleware/onlySuperAdmin.js';
import onlyBranchRoles from '../../middleware/onlyBranchRoles.js';
import requirePermission from '../../middleware/requirePermission.js';

// 1. Import the controller function
import { createSaleController } from '../../controllers/sale/createSale.controller.js';
import { updateSaleController } from '../../controllers/sale/updateSale.controller.js';
import { getSaleByIdController } from '../../controllers/sale/getSaleById.controller.js';
import { getAllSalesController } from '../../controllers/sale/getAllSales.controller.js';
import { uploadSaleSelfieController } from '../../controllers/sale/uploadSaleSelfie.controller.js';
import { reviewSaleController } from '../../controllers/sale/reviewSale.controller.js';
import { createSaleReturnController } from '../../controllers/sale/createSaleReturn.controller.js';
import { getSaleReturnsController } from '../../controllers/sale/getSaleReturns.controller.js';
import { createSaleExchangeController } from '../../controllers/sale/createSaleExchange.controller.js';
import { getSaleExchangesController } from '../../controllers/sale/getSaleExchanges.controller.js';
import { getExchangeReplacementUnitController } from '../../controllers/sale/getExchangeReplacementUnit.controller.js';
import { createSaleTradeInController } from '../../controllers/sale/createSaleTradeIn.controller.js';
import { getSaleTradeInsController } from '../../controllers/sale/getSaleTradeIns.controller.js';

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
// onlyBranchRoles + requirePermission('sale.create') gate as /create
// itself, so a STAFF user with sale.create revoked can't stage a selfie
// for a sale they can no longer create either. Confirmed used only by
// the live SaleCreate flow (SelfieCaptureModal.jsx), not shared.
router.post('/upload-selfie', authMiddleware, onlyBranchRoles, requirePermission('sale.create'), uploadSaleSelfieController);

// EOD review - `/:id/review` is more specific than the generic `GET
// /:id` below, but still kept ahead of it for clarity/consistency.
router.patch('/:id/review', authMiddleware, onlySuperAdmin, reviewSaleController);

// Sale Return - no onlyBranchRoles gate (unlike /create): SUPER_ADMIN
// can legitimately process a return even without owning branch
// inventory, since stock is coming back in, not being consumed from
// stock they don't have. requirePermission('sale.return') still lets
// SUPER_ADMIN through unconditionally and requires the grant for
// BRANCH_ADMIN/STAFF (defaults true, matches sale.create/sale.edit).
// No separate return-review route - a return resets the sale's own
// processStatus back to PENDING_REVIEW (see createSaleReturn.controller.js),
// and reviewSale.controller.js's one /:id/review action covers it -
// create/edit/return/exchange all share that single approve/reject,
// never their own independent one.
router.post('/:id/return', authMiddleware, requirePermission('sale.return'), createSaleReturnController);
router.get('/:id/returns', authMiddleware, getSaleReturnsController);

// Sale Exchange - same reasoning as Return above (no onlyBranchRoles,
// requirePermission('sale.exchange') lets SUPER_ADMIN through
// unconditionally, no separate review route).
//
// The replacement-unit lookup below is deliberately its own endpoint,
// NOT a reuse of GET /sale/scanner/:barcodeValue - that route is
// onlyBranchRoles-gated and scopes to req.user.branchId, which blocks
// SUPER_ADMIN entirely (they have no branchId) even though SUPER_ADMIN
// is explicitly allowed to process an exchange. This scopes to the
// SALE's own branch instead, matching who's actually allowed here.
router.get('/:id/exchange-scanner/:barcodeValue', authMiddleware, requirePermission('sale.exchange'), getExchangeReplacementUnitController);
router.post('/:id/exchange', authMiddleware, requirePermission('sale.exchange'), createSaleExchangeController);
router.get('/:id/exchanges', authMiddleware, getSaleExchangesController);

// Post-Sale Type 2 Exchange (Trade-In) - same reasoning as Return/
// Exchange above (no onlyBranchRoles, requirePermission('sale.tradeIn')
// lets SUPER_ADMIN through unconditionally, no separate review route -
// reviewSale.controller.js's cascade covers this too).
router.post('/:id/trade-in', authMiddleware, requirePermission('sale.tradeIn'), createSaleTradeInController);
router.get('/:id/trade-ins', authMiddleware, getSaleTradeInsController);

// Add route for getting sale by ID
router.get('/:id', authMiddleware, getSaleByIdController);

// 2. Change the route handler to use the imported controller

// onlyBranchRoles already hard-blocks SUPER_ADMIN here (untouched,
// permanent) - requirePermission only ever evaluates for BRANCH_ADMIN/
// STAFF, who need the matching sale.create grant (defaults to true for
// both today, can be individually revoked).
router.post('/create', authMiddleware, onlyBranchRoles, requirePermission('sale.create'), createSaleController);

// Sale Edit - SUPER_ADMIN always passes; BRANCH_ADMIN/STAFF need
// sale.edit. updateSaleController still resets EOD review for a
// non-SUPER_ADMIN editor and clears it for a SUPER_ADMIN editor itself,
// unaffected by this gate.
router.put('/:id', authMiddleware, requirePermission('sale.edit'), updateSaleController);

export default router;