import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import onlySuperAdmin from "../../middleware/onlySuperAdmin.js";

import { getProfitLossController } from "../../controllers/reports/getProfitLoss.controller.js";
import { getInOutReportController } from "../../controllers/reports/getInOutReport.controller.js";

// Profit & Loss is permanently Super Admin-only, like Branch/User
// management and EOD review - see config/permissionCatalog.js's
// SUPER_ADMIN_ONLY_KEYS. It's the one report that exposes cost/margin
// figures, so it's never delegated by the per-user permission system.
// In/Out stays open to any authenticated role - it's a stock movement
// register, not a financial report.
router.get("/profit-loss", authMiddleware, onlySuperAdmin, getProfitLossController);
router.get("/in-out", authMiddleware, getInOutReportController);

export default router;
