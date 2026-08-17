import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';

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
router.get('/:id', authMiddleware, getPurchaseByIdController);
// Any authenticated role (incl. STAFF) can create a purchase - matches
// createPurchase.controller.js's isBranchFlow handling, which now treats
// STAFF the same as BRANCH_ADMIN (direct purchase into their own branch).
router.post('/create', authMiddleware, createPurchaseController);
router.get('/', authMiddleware, getAllPurchasesController);




export default router;  