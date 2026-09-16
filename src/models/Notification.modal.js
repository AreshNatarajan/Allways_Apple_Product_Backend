// models/Notification.modal.js
import mongoose from "mongoose";

// ============================================================
// TRANSFER NOTIFICATIONS ONLY (see PROJECT scope - Purchase/Sale/
// Returns/Service/Stock are deliberately out of scope for now, added
// later against this same model). One row per RECIPIENT USER, not one
// row per event - this is what makes isRead/readAt a genuinely
// per-user fact (one branch user reading a notification must never
// affect another user's own unread badge) and is exactly what
// getUnreadCount/markAsRead below assume.
//
// `eventKey` + `recipientUserId` together are the idempotency guard
// (see the unique index below) - a controlled identifier like
// "TRANSFER_PACKED:<transferId>" per the spec, so the SAME status
// change can never produce a second notification for the same
// recipient no matter how many times the write is attempted (retry,
// double-click, etc.). Notification creation only ever happens from
// the backend Transfer controllers themselves, after their own
// transaction has already committed successfully - never from the
// frontend, and never for a failed operation.
// ============================================================
const notificationSchema = new mongoose.Schema(
    {
        recipientUserId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        // Denormalized snapshot of the recipient's branch/role AT
        // NOTIFICATION TIME - convenience for display/debugging only,
        // never used to RE-derive authorization (that's always done
        // fresh from the real Transfer document + the requesting user's
        // own current role/branchId, see resolveTransferRecipients.js).
        recipientBranchId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Branch",
            default: null,
        },
        recipientRole: {
            type: String,
            enum: ["SUPER_ADMIN", "BRANCH_ADMIN", "STAFF"],
            required: true,
        },

        // e.g. "TRANSFER_CREATED" | "TRANSFER_PACKED" | "TRANSFER_DISPATCHED" | "TRANSFER_RECEIVED"
        type: {
            type: String,
            required: true,
            trim: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
        },
        message: {
            type: String,
            required: true,
            trim: true,
        },

        // Generic enough to extend to other modules later without a
        // schema change - always "Transfer" for this task.
        referenceType: {
            type: String,
            required: true,
            trim: true,
        },
        referenceId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
        },

        // Transfer-specific convenience fields - the frontend can render
        // and navigate ("go to this Transfer's detail page") without a
        // second lookup. Deliberately NOT a deeper copy of the Transfer
        // itself (no items[], no branch objects) - just enough to render
        // the notification list and build the detail-page link.
        transferId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Transfer",
            required: true,
        },
        transferNumber: {
            type: String,
            required: true,
            trim: true,
        },
        // The Transfer's status AT THE TIME this notification was
        // created (PROCESSING/PACKED/DISPATCHED/RECEIVED) - a frozen
        // snapshot, never re-read from the live Transfer later.
        status: {
            type: String,
            required: true,
            trim: true,
        },

        isRead: {
            type: Boolean,
            default: false,
        },
        readAt: {
            type: Date,
            default: null,
        },

        // Idempotency key - "<type>:<transferId>", e.g.
        // "TRANSFER_PACKED:6a9...". Combined with recipientUserId via
        // the unique index below, this guarantees one notification per
        // recipient per real status change, regardless of retries/
        // reconnects/re-renders on the frontend.
        eventKey: {
            type: String,
            required: true,
            trim: true,
        },
    },
    {
        timestamps: true,
    }
);

// The actual duplicate-prevention guard.
notificationSchema.index({ eventKey: 1, recipientUserId: 1 }, { unique: true });
// Every real read path: "my notifications, newest first" / "my unread count".
notificationSchema.index({ recipientUserId: 1, createdAt: -1 });
notificationSchema.index({ recipientUserId: 1, isRead: 1 });

const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
