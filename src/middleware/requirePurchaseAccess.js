import mongoose from "mongoose";
import Purchase from "../models/Purchase.modal.js";
import { errorResponse } from "../utils/responseHandler.js";
import { canViewPurchase, canManagePurchase } from "../services/purchase/transferredInPurchases.js";

// Route guard for /purchase/:id... routes (runs after authMiddleware).
//   "view"   - open the purchase / its returns: SUPER_ADMIN, the purchase's
//              own branch, or a branch that received its stock by transfer
//              (same rule as the Purchase list).
//   "manage" - change a purchase-level record (its invoice): SUPER_ADMIN or
//              the purchase's own branch only.
// Not used on PUT /:id (edit) or POST /:id/return - those already enforce
// their own branch rules (transferred units: photos/descriptions/MDM/iCloud
// only), which this guard must not change.
const requirePurchaseAccess = (mode = "view") => async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid purchase ID", 400);
        }
        const purchase = await Purchase.findById(id).select("branchId items.branchId").lean();
        if (!purchase) {
            return errorResponse(res, "Purchase not found", 404);
        }
        const allowed = mode === "manage" ? canManagePurchase(req.user, purchase) : await canViewPurchase(req.user, purchase);
        if (!allowed) {
            return errorResponse(
                res,
                mode === "manage"
                    ? "Only the branch that made this purchase can change it"
                    : "This purchase belongs to another branch",
                403
            );
        }
        next();
    } catch (error) {
        console.error("Purchase access check error:", error);
        return errorResponse(res, "Failed to verify purchase access", 500);
    }
};

export default requirePurchaseAccess;
