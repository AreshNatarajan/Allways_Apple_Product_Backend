import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import onlySuperAdmin from "../../middleware/onlySuperAdmin.js";

import { getMoneyAnalyticsController } from "../../controllers/analytics/getMoneyAnalytics.controller.js";
import { getInventoryAnalyticsController } from "../../controllers/analytics/getInventoryAnalytics.controller.js";
import { getSalesAnalyticsController } from "../../controllers/analytics/getSalesAnalytics.controller.js";

// Business Analytics is permanently Super Admin-only end to end - every
// figure across all three pillars (Money/Inventory/Sales) is financial
// or cost-adjacent, so unlike Dashboard/In-Out Report there is no
// per-role stripping branch: the whole module is simply unreachable by
// BRANCH_ADMIN/STAFF. See
// shopping-frontend/docs/COMPLETE-ANALYTICS-IMPLEMENTATION-UI-UX.md §1/§6.
// All three pillars are now implemented.
router.get("/money", authMiddleware, onlySuperAdmin, getMoneyAnalyticsController);
router.get("/inventory", authMiddleware, onlySuperAdmin, getInventoryAnalyticsController);
router.get("/sales", authMiddleware, onlySuperAdmin, getSalesAnalyticsController);

export default router;
