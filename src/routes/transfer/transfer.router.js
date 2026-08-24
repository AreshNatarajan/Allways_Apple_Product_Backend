import express from "express";
const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";

import { getProductAvailabilityController } from "../../controllers/transfer/getProductAvailability.controller.js";
import { getTransferUnitsController } from "../../controllers/transfer/getTransferUnits.controller.js";
import { createTransferController } from "../../controllers/transfer/createTransfer.controller.js";
import { getAllTransfersController } from "../../controllers/transfer/getAllTransfers.controller.js";
import { getTransferByIdController } from "../../controllers/transfer/getTransferById.controller.js";
import { updateTransferStatusController } from "../../controllers/transfer/updateTransferStatus.controller.js";
import { getTransferHistoryByIdController } from "../../controllers/transfer/getTransferHistoryById.controller.js";
import { receiveTransferController } from "../../controllers/transfer/receiveTransfer.controller.js";

// Direct-selection flow - no request/approval, no scanning. Every
// role check is inline inside each controller (source branch only for
// pack/dispatch, destination branch only for receive, SUPER_ADMIN
// unrestricted), matching this app's existing convention of never
// gating Transfer routes at the router level.

router.get("/products/available", authMiddleware, getProductAvailabilityController);
router.get("/products/:productId/units", authMiddleware, getTransferUnitsController);

router.post("/", authMiddleware, createTransferController);
router.get("/", authMiddleware, getAllTransfersController);

router.get("/:id", authMiddleware, getTransferByIdController);

// Per-transfer status-change timeline (distinct from the summary
// `history` array already embedded in GET /:id) - registered after the
// plain GET /:id so that stays the first match for a bare id.
router.get("/:id/timeline", authMiddleware, getTransferHistoryByIdController);

router.put("/:id/status", authMiddleware, updateTransferStatusController);

// Destination Branch receive - single-shot GOOD/DAMAGED/MISSING review.
router.post("/:id/receive", authMiddleware, receiveTransferController);

export default router;
