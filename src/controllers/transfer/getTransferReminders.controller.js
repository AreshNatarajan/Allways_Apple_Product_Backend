// controllers/transfer/getTransferReminders.controller.js
import Transfer from "../../models/Transfer.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Staff kept forgetting to move transfers along, so these thresholds
// drive the global reminder modal (TransferReminderModal.jsx):
// - source branch: next step (Pack, then Dispatch) overdue after 15 min
// - destination branch: Receive overdue 18 hours after dispatch
const SOURCE_STEP_OVERDUE_MS = 15 * 60 * 1000;
const RECEIVE_OVERDUE_MS = 18 * 60 * 60 * 1000;

const NEXT_ACTION = {
    PROCESSING: "PACK",
    PACKED: "DISPATCH",
    DISPATCHED: "RECEIVE",
};

/**
 * Branch-scoped: reminders go to every user of the branch that owns the
 * next step (any source-branch user may pack/dispatch, any
 * destination-branch user may receive - see
 * updateTransferStatus.controller.js / receiveTransfer.controller.js).
 * SUPER_ADMIN has no branch and never does these steps, so gets none.
 */
export const getTransferRemindersController = async (req, res) => {
    try {
        const branchId = req.user.branchId;
        if (!branchId) {
            return successResponse(res, "No transfer reminders", { reminders: [] });
        }

        const now = Date.now();
        const sourceCutoff = new Date(now - SOURCE_STEP_OVERDUE_MS);
        const receiveCutoff = new Date(now - RECEIVE_OVERDUE_MS);

        const transfers = await Transfer.find({
            isDeleted: false,
            $or: [
                { sourceBranchId: branchId, status: "PROCESSING", createdAt: { $lte: sourceCutoff } },
                { sourceBranchId: branchId, status: "PACKED", packedAt: { $lte: sourceCutoff } },
                { destinationBranchId: branchId, status: "DISPATCHED", dispatchedAt: { $lte: receiveCutoff } },
            ],
        })
            .select("transferNumber status sourceBranchName destinationBranchName summary createdAt packedAt dispatchedAt")
            .sort({ createdAt: 1 })
            .lean();

        const reminders = transfers.map((t) => {
            const since = t.status === "PROCESSING" ? t.createdAt : t.status === "PACKED" ? t.packedAt : t.dispatchedAt;
            return {
                _id: t._id,
                transferNumber: t.transferNumber,
                status: t.status,
                nextAction: NEXT_ACTION[t.status],
                sourceBranchName: t.sourceBranchName,
                destinationBranchName: t.destinationBranchName,
                totalQuantity: t.summary?.totalQuantity || 0,
                pendingSince: since,
            };
        });

        return successResponse(res, "Transfer reminders retrieved successfully", { reminders });
    } catch (error) {
        console.error("Get Transfer Reminders Error:", error);
        return errorResponse(res, "Failed to retrieve transfer reminders", 500);
    }
};
