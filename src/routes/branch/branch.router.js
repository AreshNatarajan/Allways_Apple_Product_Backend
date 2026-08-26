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

// Branch management (including View) is permanently Super Admin-only
// end to end, never delegated by the per-user permission system - see
// config/permissionCatalog.js's SUPER_ADMIN_ONLY_KEYS. Not gated here
// at all: the controller's own inline check (SUPER_ADMIN any branch,
// everyone else only their own) already covers every branch user's
// legitimate need to view their own branch's detail page.
router.get("/:id", authMiddleware, getBranchByIdController);


router.put("/update/:id", authMiddleware, onlySuperAdmin, updateBranchController);

router.post("/:id/logo", authMiddleware, onlySuperAdmin, uploadBranchLogoController);

router.post("/:id/upi-qr", authMiddleware, onlySuperAdmin, uploadBranchUpiQrController);

export default router;

// export default router;
