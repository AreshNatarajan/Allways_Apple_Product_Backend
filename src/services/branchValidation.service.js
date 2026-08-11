import mongoose from "mongoose";
import Branch from "../models/Branch.modal.js";

/**
 * Resolves a branchId to an active, non-deleted Branch document, or a
 * specific rejection reason. A valid ObjectId alone is not enough - the
 * branch must actually exist and must be active. Shared by every
 * controller that assigns a user to a branch (create/update paths for
 * BRANCH_ADMIN and STAFF), so "does this branch exist and is it active"
 * is enforced identically everywhere instead of being reimplemented
 * (and potentially forgotten) per controller.
 *
 * Returns { error: string } on failure, or { branch } on success.
 */
export const resolveActiveBranch = async (branchId) => {
    if (!branchId) {
        return { error: "Branch ID is required" };
    }

    if (!mongoose.Types.ObjectId.isValid(branchId)) {
        return { error: "Invalid branch ID" };
    }

    const branch = await Branch.findOne({
        _id: branchId,
        isDeleted: false,
    });

    if (!branch) {
        return { error: "Branch not found" };
    }

    if (!branch.isActive) {
        return { error: "This branch is deactivated and cannot be assigned" };
    }

    return { branch };
};
