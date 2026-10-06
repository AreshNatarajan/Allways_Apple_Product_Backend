import express from "express";
const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";

import { getInventoryDashboardController } from "../../controllers/inventory/getInventoryDashboard.controller.js";
import { getSerializedInventoryController } from "../../controllers/inventory/getSerializedInventory.controller.js";
import { getNonSerializedInventoryController } from "../../controllers/inventory/getNonSerializedInventory.controller.js";
import { getSerializedItemDetailController } from "../../controllers/inventory/getSerializedItemDetail.controller.js";
import { getBatchDetailController } from "../../controllers/inventory/getBatchDetail.Controller.js";
import { updateMaxDiscountController } from "../../controllers/inventory/updateMaxDiscount.controller.js";

router.get("/dashboard", authMiddleware, getInventoryDashboardController);
router.get("/serialized", authMiddleware, getSerializedInventoryController);
router.get("/non-serialized", authMiddleware, getNonSerializedInventoryController);
router.get("/serialized/:serialNumber", authMiddleware, getSerializedItemDetailController);
router.get("/non-serialized/:productId/:branchId", authMiddleware, getBatchDetailController);
router.put("/serialized/:serialNumber/max-discount", authMiddleware, updateMaxDiscountController);

export default router;
