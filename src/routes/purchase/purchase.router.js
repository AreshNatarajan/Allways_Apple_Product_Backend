import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import onlySuperAdmin from '../../middleware/onlySuperAdmin.js';

// 1. Change the requires to modern imports

import { createPurchaseController } from '../../controllers/purchase/createPurchase.controller.js';
import { getAllPurchasesController } from '../../controllers/purchase/getAllPurchases.controller.js';
import { getPurchaseByIdController } from '../../controllers/purchase/getPurchaseById.controller.js';
import { updatePurchaseController } from '../../controllers/purchase/updatePurchase.controller.js';
import { reviewPurchaseController } from '../../controllers/purchase/reviewPurchase.controller.js';

import { statsPurchaseController } from '../../controllers/purchase/statsPurchase.controller.js';

import { uploadPurchaseInvoiceController } from '../../controllers/purchase/uploadPurchaseInvoice.controller.js'

import { checkSerialNumberController } from '../../controllers/purchase/checkSerialNumberExist.controller.js'



// import signature image 

import { uploadSignatureController } from '../../controllers/purchase/uploadSignature.controller.js'

import { uploadSignature } from '../../middleware/uploadSignature.middleware.js'


// import payment attachment

import { uploadPaymentEvidenceController } from '../../controllers/purchase/uploadPaymentEvidence.controller.js'

router.post(
    "/upload-invoice",
    authMiddleware,
    uploadPurchaseInvoiceController
);

router.post(
    '/upload-signature',
    authMiddleware,
    uploadSignature.single("signature"),
    uploadSignatureController
)

router.post(
    '/upload-payment',
    authMiddleware,
    uploadPaymentEvidenceController
)



router.post('/check-serial', authMiddleware, checkSerialNumberController)

// 2. Define the routes
router.get('/stats', authMiddleware, statsPurchaseController);
// Deliberately placed above GET /:id (method differs so ordering isn't
// strictly required, but kept for clarity - same convention as
// sale.router.js's /:id/review placement).
router.patch('/:id/review', authMiddleware, onlySuperAdmin, reviewPurchaseController);
router.get('/:id', authMiddleware, getPurchaseByIdController);
// Any authenticated role (incl. STAFF) can create a purchase - matches
// createPurchase.controller.js's isBranchFlow handling, which now treats
// STAFF the same as BRANCH_ADMIN (direct purchase into their own branch).
router.post('/create', authMiddleware, createPurchaseController);
// Same permission level as create - any authenticated role can edit a
// purchase; updatePurchaseController resets EOD review for a
// non-SUPER_ADMIN editor rather than restricting who can edit at all.
router.put('/:id', authMiddleware, updatePurchaseController);
router.get('/', authMiddleware, getAllPurchasesController);




export default router;  