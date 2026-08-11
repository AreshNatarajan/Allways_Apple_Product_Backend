import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";

import onlySuperAdmin from "../../middleware/onlySuperAdmin.js";

import { createBranchController } from "../../controllers/branch/createBranch.controller.js";
import { getBranchesController } from "../../controllers/branch/getBranch.controller.js";
import { getBranchStatsController } from "../../controllers/branch/getBranchStats.controller.js";

import { getAllBranchesController } from "../../controllers/branch/getAllBranches.controller.js";

import { getBranchByIdController } from "../../controllers/branch/getBranchById.controller.js";

import { updateBranchController } from "../../controllers/branch/updateBranch.controller.js";

import { uploadBranchLogoController } from "../../controllers/branch/uploadBranchLogo.controller.js";

import { uploadBranchUpiQrController } from "../../controllers/branch/uploadBranchUpiQr.controller.js";

router.get("/test", (req, res) => {
  res.send("WORKING");
});

router.get("/list", authMiddleware, getAllBranchesController);

router.post(
  "/create-with-admin",
  authMiddleware,
  onlySuperAdmin,
  createBranchController,
);
router.get(
  "/pagination",
  authMiddleware,
  onlySuperAdmin,
  getBranchesController,
);
router.get("/stats", authMiddleware, onlySuperAdmin, getBranchStatsController);

router.get("/:id", authMiddleware, getBranchByIdController);


router.put("/update/:id", authMiddleware, onlySuperAdmin, updateBranchController);

router.post("/:id/logo", authMiddleware, onlySuperAdmin, uploadBranchLogoController);

router.post("/:id/upi-qr", authMiddleware, onlySuperAdmin, uploadBranchUpiQrController);

export default router;

// export default router;
