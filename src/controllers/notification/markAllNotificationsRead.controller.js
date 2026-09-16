// controllers/notification/markAllNotificationsRead.controller.js
import Notification from "../../models/Notification.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const markAllNotificationsReadController = async (req, res) => {
    try {
        const result = await Notification.updateMany(
            { recipientUserId: req.user._id, isRead: false },
            { isRead: true, readAt: new Date() }
        );

        return successResponse(res, "All notifications marked as read", {
            modifiedCount: result.modifiedCount,
        });
    } catch (error) {
        console.error("Mark All Notifications Read Error:", error);
        return errorResponse(res, error.message || "Failed to mark all notifications as read", 500);
    }
};
