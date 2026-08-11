import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';

import { getPendingReceivesController } from '../../controllers/pendingReceives/getPendingReceives.controller.js'
import { getPurchaseReceiveDetailsController } from "../../controllers/pendingReceives/getPurchaseReceiveDetails.controller.js"
import { bulkReceiveController } from '../../controllers/pendingReceives/bulkReceive.controller.js'


router.get('/pending-receives' , authMiddleware , getPendingReceivesController);
router.get('/:purchaseId/receive-details', authMiddleware, getPurchaseReceiveDetailsController);
router.post('/bulk-receive', authMiddleware , bulkReceiveController);


export default router;