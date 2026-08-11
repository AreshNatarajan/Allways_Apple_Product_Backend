import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import onlySuperAdmin from "../../middleware/onlySuperAdmin.js";

import { getGstConfigController } from "../../controllers/gstConfig/getGstConfig.controller.js";
import { updateGstConfigController } from "../../controllers/gstConfig/updateGstConfig.controller.js";

router.get("/", authMiddleware, getGstConfigController);
router.put("/update", authMiddleware, onlySuperAdmin, updateGstConfigController);

export default router;
