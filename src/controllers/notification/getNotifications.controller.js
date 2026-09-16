// controllers/notification/getNotifications.controller.js
import Notification from "../../models/Notification.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Always scoped to the AUTHENTICATED user's own recipientUserId - never
// a value the client can supply. A SUPER_ADMIN's own notifications were
// already fanned out to their own user id at creation time (see
// notifyTransferEvent.js), so this needs no special-casing for role;
// "my notifications" is already the right query for every role.
export const getNotificationsController = async (req, res) => {
    try {
        const user = req.user;
        const { limit = 20, page = 1, unreadOnly } = req.query;
        const parsedLimit = Math.min(parseInt(limit) || 20, 100);
        const skip = (Math.max(parseInt(page) || 1, 1) - 1) * parsedLimit;

        const filter = { recipientUserId: user._id };
        if (unreadOnly === "true") filter.isRead = false;

        const [notifications, total] = await Promise.all([
            Notification.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parsedLimit)
                .lean(),
            Notification.countDocuments(filter),
        ]);

        return successResponse(res, "Notifications retrieved successfully", {
            notifications,
            pagination: {
                total,
                page: parseInt(page) || 1,
                limit: parsedLimit,
                totalPages: Math.max(1, Math.ceil(total / parsedLimit)),
            },
        });
    } catch (error) {
        console.error("Get Notifications Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve notifications", 500);
    }
};
