// services/notification/resolveTransferRecipients.js
import User from "../../models/User.js";

// SUPER_ADMIN is ALWAYS included, never restricted by branch - per the
// task spec's explicit rule. Branch recipients are every active,
// non-deleted BRANCH_ADMIN/STAFF user whose own `branchId` matches one
// of the given branches - "the existing authorized branch users",
// matching how every other branch-scoped feature in this app already
// determines who belongs to a branch (a user's own branchId field,
// nothing else, and NEVER a branchId supplied by the caller/frontend -
// the caller here always passes the Transfer document's own real
// sourceBranchId/destinationBranchId, resolved server-side).
export const resolveTransferRecipients = async (branchIds = []) => {
    const uniqueBranchIds = [...new Set(branchIds.filter(Boolean).map(String))];

    const [superAdmins, branchUsers] = await Promise.all([
        User.find({ role: "SUPER_ADMIN", isActive: true, isDeleted: false }).select("_id role branchId"),
        uniqueBranchIds.length > 0
            ? User.find({
                  role: { $in: ["BRANCH_ADMIN", "STAFF"] },
                  branchId: { $in: uniqueBranchIds },
                  isActive: true,
                  isDeleted: false,
              }).select("_id role branchId")
            : Promise.resolve([]),
    ]);

    // De-duplicated by user id - a SUPER_ADMIN has no branchId so can
    // never collide with a branch user, but this stays correct even if
    // that ever changes.
    const byId = new Map();
    for (const u of [...superAdmins, ...branchUsers]) byId.set(String(u._id), u);
    return [...byId.values()];
};
