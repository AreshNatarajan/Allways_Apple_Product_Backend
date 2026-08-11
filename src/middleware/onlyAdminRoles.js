import { errorResponse } from '../utils/responseHandler.js';

// Allows SUPER_ADMIN and BRANCH_ADMIN, blocks STAFF. Used for Product
// mutation routes - Product.createdByRole only ever accepts these two
// roles, so STAFF was never a valid product author even before this
// middleware existed to enforce it at the route level.
const onlyAdminRoles = (req, res, next) => {
    if (!["SUPER_ADMIN", "BRANCH_ADMIN"].includes(req.user.role)) {
        return errorResponse(
            res,
            "Only Super Admin or Branch Admin can access this",
            403
        );
    }
    next();
};

export default onlyAdminRoles;
