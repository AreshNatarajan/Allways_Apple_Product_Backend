// middleware/branchFilter.js

/**
 * Get branch filter based on user role
 * - SUPER_ADMIN: Can filter by branchId (if provided) or see all
 * - BRANCH_ADMIN: Always filtered by their own branch
 */
export const getBranchFilter = (user, branchId = null) => {
  if (!user) return {};

  // SUPER_ADMIN: Can see all or filter by branch
  if (user.role === "SUPER_ADMIN") {
    if (branchId) {
      return { branchId };
    }
    return {}; // All branches
  }

  // BRANCH_ADMIN: Only their branch
  if (user.role === "BRANCH_ADMIN") {
    if (!user.branchId) {
      return {}; // No branch assigned - return empty (will show no results)
    }
    return { branchId: user.branchId };
  }

  return {};
};