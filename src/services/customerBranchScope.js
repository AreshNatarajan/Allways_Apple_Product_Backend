import { getBranchFilter } from "../middleware/branchFilter.js";

/**
 * Customer-specific branch filter. Wraps the shared getBranchFilter
 * (SUPER_ADMIN: unrestricted/optional branchId, BRANCH_ADMIN: forced
 * to own branch) and additionally forces STAFF to their own branch -
 * getBranchFilter itself falls through to `{}` (no filter) for STAFF,
 * which would leak every branch's customers to STAFF users. Customer
 * is explicitly required to be branch-isolated for STAFF too, but the
 * shared helper is also used by Sale/Inventory/Purchase/Transfer/
 * Dashboard, which are out of scope for the Customer Master phase -
 * so the fix is scoped to Customer only, here, instead of editing the
 * shared middleware.
 */
export const getCustomerBranchFilter = (user, branchId = null) => {
  const filter = getBranchFilter(user, branchId);

  if (user?.role === "STAFF") {
    if (!user.branchId) return { ...filter, branchId: null };
    return { ...filter, branchId: user.branchId };
  }

  return filter;
};
