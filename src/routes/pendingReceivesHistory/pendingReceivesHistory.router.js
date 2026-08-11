import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';


import { getAllReceiveHistoryController } from '../../controllers/pendigReceivesHistory/pendingReceiveHistory.controller.js'
import { getReceiveHistoryByIdController } from '../../controllers/pendigReceivesHistory/getReceiveHistoryByID.controller.js'


router.get('/', authMiddleware, getAllReceiveHistoryController);
router.get('/:id', authMiddleware, getReceiveHistoryByIdController);


export default router;