import { errorResponse } from '../utils/responseHandler.js';

// Router-middleware factory for the per-user permission system (see
// config/permissionCatalog.js). SUPER_ADMIN always passes - their
// access is fixed in code, never gated by this field. Every other role
// passes only if `req.user.permissions[key] === true`, which can
// genuinely exceed what their role could do before this system existed
// (e.g. a STAFF user granted product.create) - that's the deliberate
// point of a per-user grant instead of a role check.
//
// Never applied to Sale creation's SUPER_ADMIN block, EOD review
// (Approve/Reject), or any Branch/User CRUD route - those stay exactly
// onlyBranchRoles/onlySuperAdmin as before, untouched by this system.
const requirePermission = (key) => (req, res, next) => {
    if (req.user.role === "SUPER_ADMIN") {
        return next();
    }
    if (req.user.permissions?.[key] === true) {
        return next();
    }
    return errorResponse(
        res,
        "You don't have permission to perform this action",
        403
    );
};

export default requirePermission;
