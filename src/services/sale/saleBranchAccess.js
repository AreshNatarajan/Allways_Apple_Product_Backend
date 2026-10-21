// services/sale/saleBranchAccess.js
//
// One rule for "may this user touch this sale": SUPER_ADMIN may act on any
// branch's sale; everyone else only on a sale made by their own branch.
// Used by the requireSaleBranch route guard (every /sale/:id... route) and
// again inside each controller that changes a sale (return, exchange,
// trade-in, edit, invoice), so a new route can't silently skip it.
//
// The sale list (getAllSales.controller.js) already scopes branch users to
// their own branch - this closes the direct-by-ID and serial-lookup paths,
// where another branch's user could open a sale and act on it (e.g. a
// mistaken return).

export const OTHER_BRANCH_SALE_MESSAGE = "This sale belongs to another branch - only that branch can view or change it";

const idOf = (v) => String(v?._id ?? v ?? "");

export const canAccessSaleBranch = (user, saleBranchId) => {
    if (user?.role === "SUPER_ADMIN") return true;
    if (!user?.branchId || !saleBranchId) return false;
    return idOf(saleBranchId) === idOf(user.branchId);
};
