import express from "express";
const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import requirePermission from "../../middleware/requirePermission.js";

import { getServiceableUnitsController } from "../../controllers/service/getServiceableUnits.controller.js";
import { lookupServiceableUnitBySerialController } from "../../controllers/service/lookupServiceableUnitBySerial.controller.js";
import { createServiceController } from "../../controllers/service/createService.controller.js";
import { getAllServicesController } from "../../controllers/service/getAllServices.controller.js";
import { getServiceByIdController } from "../../controllers/service/getServiceById.controller.js";
import { getServiceHistoryByIdController } from "../../controllers/service/getServiceHistoryById.controller.js";
import { updateServiceStatusController } from "../../controllers/service/updateServiceStatus.controller.js";
import { uploadServiceItemStagingImagesController } from "../../controllers/service/uploadServiceItemStagingImages.controller.js";
import { deleteServiceItemStagingImageController } from "../../controllers/service/deleteServiceItemStagingImage.controller.js";

// Service is NOT Transfer - its own model, its own status lifecycle,
// its own append-only ServiceHistory. Every role check is inline
// inside each controller (origin branch vs. Service branch), matching
// this app's existing convention of never gating Transfer-style routes
// at the router level - see updateServiceStatus.controller.js.

router.get("/inventory/lookup", authMiddleware, lookupServiceableUnitBySerialController);
router.get("/inventory/:productId/units", authMiddleware, getServiceableUnitsController);

router.post("/staging-images", authMiddleware, requirePermission("service.create"), uploadServiceItemStagingImagesController);
router.delete("/staging-images", authMiddleware, requirePermission("service.create"), deleteServiceItemStagingImageController);

router.post("/", authMiddleware, createServiceController);
router.get("/", authMiddleware, getAllServicesController);

router.get("/:id", authMiddleware, getServiceByIdController);
router.get("/:id/timeline", authMiddleware, getServiceHistoryByIdController);
router.put("/:id/status", authMiddleware, updateServiceStatusController);

export default router;
