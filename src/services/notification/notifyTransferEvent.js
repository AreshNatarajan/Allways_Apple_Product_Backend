// services/notification/notifyTransferEvent.js
import Notification from "../../models/Notification.modal.js";
import { resolveTransferRecipients } from "./resolveTransferRecipients.js";
import { getIO, userRoom } from "../../socket/index.js";

const TYPE_TITLE = {
    TRANSFER_CREATED: "New Transfer Created",
    TRANSFER_PACKED: "Transfer Packed",
    TRANSFER_DISPATCHED: "Transfer Dispatched",
    TRANSFER_RECEIVED: "Transfer Received",
};

/**
 * Fires one Transfer notification event to its recipients - MongoDB
 * write + Socket.IO push. Call this ONLY after the Transfer
 * controller's own transaction has already committed successfully
 * (every call site in this app calls it right after
 * `session.commitTransaction()`) - never from inside the transaction,
 * and never at all if the underlying operation failed. Frontend status
 * changes never call this directly; it only ever runs from the
 * backend controller that actually performed the status change.
 *
 * `branchIds` is exactly the set of branches this event notifies
 * (destination-only for CREATED/PACKED/DISPATCHED, source-only for
 * RECEIVED - see each Transfer controller's own call site for which).
 * SUPER_ADMIN is added on top of that unconditionally inside
 * resolveTransferRecipients, regardless of what's passed here.
 *
 * Idempotent: `eventKey = "<type>:<transferId>"` combined with each
 * recipient's own user id is a unique index on the Notification model
 * (see Notification.modal.js) - a retry/reconnect/re-render calling
 * this again for the same event+recipient silently no-ops instead of
 * creating a second row or a second real-time push.
 *
 * Never throws - a notification failure must never surface as a
 * Transfer operation failure, since by the time this runs the real
 * Transfer operation has already succeeded and committed.
 */
export const notifyTransferEvent = async ({ type, transfer, branchIds }) => {
    try {
        const title = TYPE_TITLE[type];
        if (!title) throw new Error(`Unknown transfer notification type: ${type}`);

        const itemCount = transfer.summary?.totalItems ?? transfer.items?.length ?? 0;
        const message = `From ${transfer.sourceBranchName} to ${transfer.destinationBranchName} · Items: ${itemCount}`;

        const recipients = await resolveTransferRecipients(branchIds);
        if (recipients.length === 0) return [];

        const eventKey = `${type}:${transfer._id}`;
        const io = getIO();
        const created = [];

        for (const recipient of recipients) {
            try {
                const doc = await Notification.create({
                    recipientUserId: recipient._id,
                    recipientBranchId: recipient.branchId || null,
                    recipientRole: recipient.role,
                    type,
                    title,
                    message,
                    referenceType: "Transfer",
                    referenceId: transfer._id,
                    transferId: transfer._id,
                    transferNumber: transfer.transferNumber,
                    status: transfer.status,
                    eventKey,
                });
                created.push(doc);
                io.to(userRoom(recipient._id)).emit("notification:new", doc.toObject());
            } catch (err) {
                // 11000 = duplicate key on (eventKey, recipientUserId) -
                // the idempotency guard doing exactly its job. Anything
                // else is logged, never re-thrown.
                if (err.code !== 11000) {
                    console.error(`Notification create failed for user ${recipient._id}:`, err);
                }
            }
        }

        return created;
    } catch (error) {
        console.error(`notifyTransferEvent(${type}) failed:`, error);
        return [];
    }
};
