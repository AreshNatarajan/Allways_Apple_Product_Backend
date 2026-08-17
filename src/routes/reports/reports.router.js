import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";

import { getProfitLossController } from "../../controllers/reports/getProfitLoss.controller.js";
import { getInOutReportController } from "../../controllers/reports/getInOutReport.controller.js";

// Any authenticated role (incl. STAFF) can view these reports - just
// needs to be logged in. Branch scoping still applies the same as
// everywhere else: SUPER_ADMIN sees all/filters by branch, everyone
// else (BRANCH_ADMIN and STAFF alike) is forced to their own branch by
// the controllers themselves.
router.get("/profit-loss", authMiddleware, getProfitLossController);
router.get("/in-out", authMiddleware, getInOutReportController);

export default router;
