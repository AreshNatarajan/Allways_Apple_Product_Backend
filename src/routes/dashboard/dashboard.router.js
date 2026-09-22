import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import onlySuperAdmin from "../../middleware/onlySuperAdmin.js";


import { getDashboardController } from '../../controllers/dashboard/getDashboard.controller.js'
import { getProfitTrendDetailController } from '../../controllers/dashboard/getProfitTrendDetail.controller.js'
import { getRevenueTrendDetailController } from '../../controllers/dashboard/getRevenueTrendDetail.controller.js'

router.get('/stats', authMiddleware,  getDashboardController);
// SUPER_ADMIN-only drill-down for one Profit Trend chart point - see
// getProfitTrendDetail.controller.js's own comment.
router.get('/profit-trend-detail', authMiddleware, onlySuperAdmin, getProfitTrendDetailController);
// Open to every role, matching Revenue Trend's own chart visibility
// (sales/purchase totals, not profit) - branch-scoped server-side for
// non-SUPER_ADMIN regardless of what's in the query string.
router.get('/revenue-trend-detail', authMiddleware, getRevenueTrendDetailController);

export default router;