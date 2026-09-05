import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import onlySuperAdmin from '../../middleware/onlySuperAdmin.js';
import requirePermission from '../../middleware/requirePermission.js';

// 1. Change the requires to modern imports

import { createPurchaseController } from '../../controllers/purchase/createPurchase.controller.js';
import { getAllPurchasesController } from '../../controllers/purchase/getAllPurchases.controller.js';
import { getPurchaseByIdController } from '../../controllers/purchase/getPurchaseById.controller.js';
import { updatePurchaseController } from '../../controllers/purchase/updatePurchase.controller.js';
import { reviewPurchaseController } from '../../controllers/purchase/reviewPurchase.controller.js';

import { statsPurchaseController } from '../../controllers/purchase/statsPurchase.controller.js';

import { uploadPurchaseInvoiceController } from '../../controllers/purchase/uploadPurchaseInvoice.controller.js'

import { checkSerialNumberController } from '../../controllers/purchase/checkSerialNumberExist.controller.js'
import { getPurchaseItemBySerialController } from '../../controllers/purchase/getPurchaseItemBySerial.controller.js'



// import signature image 

import { uploadSignatureController } from '../../controllers/purchase/uploadSignature.controller.js'

import { uploadSignature } from '../../middleware/uploadSignature.middleware.js'


// import payment attachment

import { uploadPaymentEvidenceController } from '../../controllers/purchase/uploadPaymentEvidence.controller.js'

// Pre-upload endpoints, called before the Purchase document exists
// (staging) - same requirePermission('purchase.create') gate as the
// purchase-creation flow they're actually part of, so a STAFF user with
// that grant revoked can't stage evidence for a purchase they can no
// longer create either. Confirmed Purchase-only in the live app (the
// only other importer of uploadSignatureAPI is SaleCreateEntryTable.jsx,
// which isn't wired into any route).
router.post(
    "/upload-invoice",
    authMiddleware,
    requirePermission('purchase.create'),
    uploadPurchaseInvoiceController
);

router.post(
    '/upload-signature',
    authMiddleware,
    requirePermission('purchase.create'),
    uploadSignature.single("signature"),
    uploadSignatureController
)

// NOT gated by purchase.create - this endpoint is genuinely shared
// (plain S3 image upload, no ownership check) across Purchase's own
// PaymentDetails, Sale's SalePaymentSection, and SaleReturnModal's
// refund evidence upload. Stays open to any authenticated user, same
// as it's always been - narrowing it to purchase.create would silently
// break Sale/Return evidence uploads for anyone without that grant.
router.post(
    '/upload-payment',
    authMiddleware,
    uploadPaymentEvidenceController
)



router.post('/check-serial', authMiddleware, checkSerialNumberController)

// Purchase List page's serial-search lookup - two path segments, so
// this never collides with GET /:id below regardless of registration
// order (kept above it anyway for clarity, same convention as /stats).
router.get('/serial/:serialNumber', authMiddleware, getPurchaseItemBySerialController)

// 2. Define the routes
router.get('/stats', authMiddleware, statsPurchaseController);
// Deliberately placed above GET /:id (method differs so ordering isn't
// strictly required, but kept for clarity - same convention as
// sale.router.js's /:id/review placement).
router.patch('/:id/review', authMiddleware, onlySuperAdmin, reviewPurchaseController);
router.get('/:id', authMiddleware, getPurchaseByIdController);
// SUPER_ADMIN always passes (fixed access); BRANCH_ADMIN/STAFF need the
// matching per-user grant (requirePermission - see config/permissionCatalog.js),
// which defaults to true for both today - matches createPurchase.controller.js's
// isBranchFlow handling, which treats STAFF the same as BRANCH_ADMIN
// (direct purchase into their own branch) - but can be individually revoked.
router.post('/create', authMiddleware, requirePermission('purchase.create'), createPurchaseController);
// Same pattern as create - updatePurchaseController still resets EOD
// review for a non-SUPER_ADMIN editor regardless, this only gates
// whether they can reach the edit at all.
router.put('/:id', authMiddleware, requirePermission('purchase.edit'), updatePurchaseController);
router.get('/', authMiddleware, getAllPurchasesController);




export default router;  