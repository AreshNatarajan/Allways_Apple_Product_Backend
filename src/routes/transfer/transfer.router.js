import express from "express";
const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";

import { getProductAvailabilityController } from '../../controllers/transfer/getProductAvailability.controller.js'

import { createTransferController } from '../../controllers/transfer/createTransfer.controller.js'

import { getPendingTransfersController } from "../../controllers/transfer/getPendingTransfers.controller.js";

import { getTransferByIdController } from "../../controllers/transfer/getTransferById.controller.js";

import { updateTransferStatusController } from "../../controllers/transfer/updateTransferStatus.ontroller.js";

import { getTransferHistoryController } from '../../controllers/transfer/getTransferHistory.controller.js'

import { getTransferHistoryByIdController } from "../../controllers/transfer/getTransferHistoryById.controller.js";

import { packTransferController } from "../../controllers/transfer/packTransfer.controller.js";

import { receiveTransferController } from "../../controllers/transfer/receiveTransfer.controller.js";



router.get('/history', authMiddleware, getTransferHistoryController)


router.get("/products/available", authMiddleware, getProductAvailabilityController);


router.post("/", authMiddleware, createTransferController);


router.get("/pending", authMiddleware, getPendingTransfersController);



router.get("/:id", authMiddleware, getTransferByIdController);

// Per-transfer status-change timeline (distinct from the summary
// `history` array already embedded in GET /:id) - registered after the
// plain GET /:id so that stays the first match for a bare id.
router.get("/:id/timeline", authMiddleware, getTransferHistoryByIdController);

router.put("/:id/status", authMiddleware, updateTransferStatusController);

// Phase 2 - Source Branch packing (scan/manual serial + batch entry).
router.post("/:id/pack", authMiddleware, packTransferController);

// Phase 3 - Destination Branch receive (GOOD/DAMAGED/MISSING + remarks).
router.post("/:id/receive", authMiddleware, receiveTransferController);


export default router;