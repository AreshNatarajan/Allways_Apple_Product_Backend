import express from "express";
const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import requirePermission from "../../middleware/requirePermission.js";

import { createServiceVendorController } from "../../controllers/serviceVendor/createServiceVendor.controller.js";
import { updateServiceVendorController } from "../../controllers/serviceVendor/updateServiceVendor.controller.js";
import { getAllServiceVendorsController, getServiceVendorOptionsController } from "../../controllers/serviceVendor/getAllServiceVendors.controller.js";
import { getServiceVendorController } from "../../controllers/serviceVendor/getServiceVendor.controller.js";
import { deactivateServiceVendorController } from "../../controllers/serviceVendor/deactivateServiceVendor.controller.js";

// ServiceVendor is a GLOBAL master (no branchId), deliberately separate
// from Vendor (the purchase-supplier concept) - see
// models/ServiceVendor.modal.js. Reads open to any authenticated role;
// mutations gated by the serviceVendor.manage permission.

router.get("/options", authMiddleware, getServiceVendorOptionsController);
router.get("/", authMiddleware, getAllServiceVendorsController);
router.get("/:id", authMiddleware, getServiceVendorController);

router.post("/", authMiddleware, requirePermission("serviceVendor.manage"), createServiceVendorController);
router.put("/:id", authMiddleware, requirePermission("serviceVendor.manage"), updateServiceVendorController);
router.patch("/:id/status", authMiddleware, requirePermission("serviceVendor.manage"), deactivateServiceVendorController);

export default router;
