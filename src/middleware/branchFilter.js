// middleware/branchFilter.js

// Matches no document - for a user who must be branch-scoped but has no
// branch assigned (they see nothing, never everything).
export const NO_BRANCH_MATCH = { $in: [] };

/**
 * Get branch filter based on user role
 * - SUPER_ADMIN: Can filter by branchId (if provided) or see all
 * - Every other role (BRANCH_ADMIN, STAFF): always their own branch only;
 *   no branch assigned -> matches nothing. (Previously STAFF, and a
 *   BRANCH_ADMIN with no branch, got `{}` - every branch's data.)
 */
export const getBranchFilter = (user, branchId = null) => {
  if (!user) return { branchId: NO_BRANCH_MATCH };

  // SUPER_ADMIN: Can see all or filter by branch
  if (user.role === "SUPER_ADMIN") {
    if (branchId) {
      return { branchId };
    }
    return {}; // All branches
  }

  // Everyone else: only their own branch
  if (!user.branchId) {
    return { branchId: NO_BRANCH_MATCH };
  }
  return { branchId: user.branchId };
};
