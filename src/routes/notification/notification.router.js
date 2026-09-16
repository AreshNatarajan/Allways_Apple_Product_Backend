import express from "express";
const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import { getNotificationsController } from "../../controllers/notification/getNotifications.controller.js";
import { getUnreadNotificationCountController } from "../../controllers/notification/getUnreadNotificationCount.controller.js";
import { markNotificationReadController } from "../../controllers/notification/markNotificationRead.controller.js";
import { markAllNotificationsReadController } from "../../controllers/notification/markAllNotificationsRead.controller.js";

// Every route is scoped to the authenticated user's own notifications
// (recipientUserId: req.user._id, derived server-side) - see each
// controller. No role check needed at the router level: a SUPER_ADMIN
// sees their own SUPER_ADMIN-wide notifications the same way a branch
// user sees their own branch-scoped ones, both just by being "me".
router.get("/", authMiddleware, getNotificationsController);
router.get("/unread-count", authMiddleware, getUnreadNotificationCountController);
router.patch("/read-all", authMiddleware, markAllNotificationsReadController);
router.patch("/:id/read", authMiddleware, markNotificationReadController);

export default router;
