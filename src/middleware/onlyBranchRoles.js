import { errorResponse } from '../utils/responseHandler.js'

// Sale creation/handling is BRANCH_ADMIN / STAFF only - a SUPER_ADMIN
// has no branchId by design (they oversee every branch, not one),
// which meant this rule was previously only enforced as an accidental
// side effect (createSale/scanner controllers 400ing on a missing
// branchId), not an explicit gate - a SUPER_ADMIN could reach the
// Create Sale screen and only discover they're blocked mid-flow with a
// confusing error. This makes the actual rule explicit. SUPER_ADMIN
// still keeps full read access to sale list/detail/stats (oversight,
// EOD review) - this middleware is only applied to the
// creation-specific routes, never to GET list/detail/stats.
const onlyBranchRoles = (req, res, next) => {
    if (!["BRANCH_ADMIN", "STAFF"].includes(req.user.role)) {
        return errorResponse(
            res,
            "Only Branch Admin or Staff can perform this action",
            403
        );
    }
    next();
};

export default onlyBranchRoles;
