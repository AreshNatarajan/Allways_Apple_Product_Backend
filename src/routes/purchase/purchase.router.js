import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import onlyAdminRoles from '../../middleware/onlyAdminRoles.js';
import onlySuperAdmin from '../../middleware/onlySuperAdmin.js';

// 1. Change the requires to modern imports

import { createPurchaseController } from '../../controllers/purchase/createPurchase.controller.js';
import { getAllPurchasesController } from '../../controllers/purchase/getAllPurchases.controller.js';
import { getPurchaseByIdController } from '../../controllers/purchase/getPurchaseById.controller.js';

import { statsPurchaseController } from '../../controllers/purchase/statsPurchase.controller.js';

import { uploadPurchaseInvoiceController } from '../../controllers/purchase/uploadPurchaseInvoice.controller.js'

import { checkSerialNumberController } from '../../controllers/purchase/checkSerialNumberExist.controller.js'



// import signature image 

import { uploadSignatureController } from '../../controllers/purchase/uploadSignature.controller.js'

import { uploadSignature } from '../../middleware/uploadSignature.middleware.js'


// import payment attachment

import { uploadPaymentEvidenceController } from '../../controllers/purchase/uploadPaymentEvidence.controller.js'

// import accountability selfie (branch purchases)

import { uploadPurchaseSelfieController } from '../../controllers/purchase/uploadPurchaseSelfie.controller.js'

// import EOD (End of Day) approval review - reviewed directly from a
// purchase's own detail page (AccountabilityCard.jsx), no separate
// review-list endpoint.

import { reviewPurchaseController } from '../../controllers/purchase/reviewPurchase.controller.js'

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

router.post('/upload-selfie', authMiddleware, uploadPurchaseSelfieController)

// 2. Define the routes
router.get('/stats', authMiddleware, statsPurchaseController);
// `/:id/review` is more specific than the generic `GET /:id` below, but
// still must stay ahead of it for clarity/consistency.
router.patch('/:id/review', authMiddleware, onlySuperAdmin, reviewPurchaseController);
router.get('/:id', authMiddleware, getPurchaseByIdController);
router.post('/create', authMiddleware, onlyAdminRoles, createPurchaseController);
router.get('/', authMiddleware, getAllPurchasesController);




export default router;  