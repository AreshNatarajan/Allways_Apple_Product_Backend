import ProductSerial from "../../models/ProductSerial.modal.js";
import { getBranchFilter } from "../../middleware/branchFilter.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getPurchasedProductStatsController =
    async (req, res) => {

        try {

            // Same branch scope as the list (getAllPurchasedProducts):
            // SUPER_ADMIN every branch, everyone else only units at their branch.
            const { branchId: scopedBranch } = getBranchFilter(req.user);
            const scope = scopedBranch ? { currentBranchId: scopedBranch } : {};

            const [
                totalProducts,
                availableProducts,
                soldProducts,
                returnedProducts,
            ] = await Promise.all([

                ProductSerial.countDocuments(scope),

                ProductSerial.countDocuments({
                    ...scope,
                    status: "AVAILABLE",
                }),

                ProductSerial.countDocuments({
                    ...scope,
                    status: "SOLD",
                }),

                ProductSerial.countDocuments({
                    ...scope,
                    status: "RETURNED",
                }),
            ]);

            return successResponse(
                res,
                "Purchased product stats retrieved successfully",
                {
                    totalProducts,
                    availableProducts,
                    soldProducts,
                    returnedProducts,
                }
            );

        } catch (error) {

            console.error(
                "Purchased Product Stats Error:",
                error
            );

            return errorResponse(
                res,
                "Failed to retrieve purchased product stats",
                500
            );

        }

    };