// controllers/notification/getUnreadNotificationCount.controller.js
import Notification from "../../models/Notification.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const getUnreadNotificationCountController = async (req, res) => {
    try {
        const count = await Notification.countDocuments({
            recipientUserId: req.user._id,
            isRead: false,
        });
        return successResponse(res, "Unread count retrieved successfully", { count });
    } catch (error) {
        console.error("Get Unread Notification Count Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve unread count", 500);
    }
};
