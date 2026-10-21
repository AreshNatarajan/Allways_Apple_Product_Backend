import mongoose from "mongoose";
import Sale from "../models/Sale.modal.js";
import { errorResponse } from "../utils/responseHandler.js";
import { canAccessSaleBranch, OTHER_BRANCH_SALE_MESSAGE } from "../services/sale/saleBranchAccess.js";

// Route guard for every /sale/:id... route: the sale must belong to the
// user's own branch (SUPER_ADMIN: any branch). Runs after authMiddleware.
// Branch users only ever see their own branch's sales in the list - this
// stops them reaching another branch's sale by ID (an old link, a serial
// search, a shared URL) and viewing, returning, exchanging, trading in or
// editing it. Sale.branchId is frozen, so checking it here up front is
// as good as checking it inside each controller's own transaction.
const requireSaleBranch = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid sale ID", 400);
        }
        const sale = await Sale.findById(id).select("branchId").lean();
        if (!sale) {
            return errorResponse(res, "Sale not found", 404);
        }
        if (!canAccessSaleBranch(req.user, sale.branchId)) {
            return errorResponse(res, OTHER_BRANCH_SALE_MESSAGE, 403);
        }
        next();
    } catch (error) {
        console.error("Sale branch check error:", error);
        return errorResponse(res, "Failed to verify sale access", 500);
    }
};

export default requireSaleBranch;
