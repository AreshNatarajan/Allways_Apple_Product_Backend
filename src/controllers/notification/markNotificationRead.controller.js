// controllers/notification/markNotificationRead.controller.js
import mongoose from "mongoose";
import Notification from "../../models/Notification.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// The filter includes recipientUserId: req.user._id - not just `_id` -
// so a user can never mark (or even discover the existence of) another
// user's notification by guessing an id. Idempotent: marking an
// already-read notification read again just succeeds with no change.
export const markNotificationReadController = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid notification id", 400);
        }

        const notification = await Notification.findOneAndUpdate(
            { _id: id, recipientUserId: req.user._id },
            { isRead: true, readAt: new Date() },
            { new: true }
        );

        if (!notification) {
            return errorResponse(res, "Notification not found", 404);
        }

        return successResponse(res, "Notification marked as read", { notification });
    } catch (error) {
        console.error("Mark Notification Read Error:", error);
        return errorResponse(res, error.message || "Failed to mark notification as read", 500);
    }
};
