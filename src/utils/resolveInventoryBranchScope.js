import { resolveActiveBranch } from "../services/branchValidation.service.js";

// Any authenticated role may browse another branch's read-only stock -
// needed so a branch user can check what a DIFFERENT branch has before
// requesting a Transfer. This mirrors an already-accepted pattern in
// this codebase: the Transfer flow's own
// controllers/transfer/getProductAvailability.controller.js already
// lets any role query any branch's availability unrestricted, so this
// is not a new risk class, just extending the same read-only
// visibility into the Inventory screen. Cost fields (purchase price/
// profit) stay SUPER_ADMIN-only regardless of which branch is being
// viewed - that gate is independent (see stripInventoryCostFields.js).
//
// Returns exactly one of:
//   { scopedBranchId }  - null means "no restriction, every branch" (SUPER_ADMIN only)
//   { noBranch: true }  - caller has no branchId and isn't SUPER_ADMIN
//   { error }           - the requested branchId doesn't resolve to a real, active branch
export const resolveInventoryBranchScope = async (user, branchId) => {
    if (branchId && branchId !== "ALL") {
        const { branch, error } = await resolveActiveBranch(branchId);
        if (error) return { error };
        return { scopedBranchId: branch._id };
    }
    if (user.role === "SUPER_ADMIN") {
        return { scopedBranchId: null };
    }
    if (!user.branchId) {
        return { noBranch: true };
    }
    return { scopedBranchId: user.branchId };
};
