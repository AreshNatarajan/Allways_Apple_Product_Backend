import { errorResponse } from '../utils/responseHandler.js'


const onlySuperAdmin = (req, res, next) => {
    if (req.user.role !== "SUPER_ADMIN") {
        return errorResponse(
            res,
            "Only Super Admin can access this",
            403
        );
    }
    next();
};

export default onlySuperAdmin;