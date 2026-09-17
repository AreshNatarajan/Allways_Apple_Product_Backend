import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import onlySuperAdmin from "../../middleware/onlySuperAdmin.js";


import { getDashboardController } from '../../controllers/dashboard/getDashboard.controller.js'
import { getProfitTrendDetailController } from '../../controllers/dashboard/getProfitTrendDetail.controller.js'

router.get('/stats', authMiddleware,  getDashboardController);
// SUPER_ADMIN-only drill-down for one Profit Trend chart point - see
// getProfitTrendDetail.controller.js's own comment.
router.get('/profit-trend-detail', authMiddleware, onlySuperAdmin, getProfitTrendDetailController);

export default router;