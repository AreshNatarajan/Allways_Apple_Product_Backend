import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import onlyAdminRoles from "../../middleware/onlyAdminRoles.js";

import { getProfitLossController } from "../../controllers/reports/getProfitLoss.controller.js";

// Financial reports are SUPER_ADMIN/BRANCH_ADMIN only - STAFF never
// sees company-wide profit/margin figures (same gate already used for
// Product mutations, reused here for the same "not for STAFF" reason).
router.get("/profit-loss", authMiddleware, onlyAdminRoles, getProfitLossController);

export default router;
