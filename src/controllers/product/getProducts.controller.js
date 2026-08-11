import Product from "../../models/Product.modal.js";
import paginate from "../../utils/pagination.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getProductsController = async (
    req,
    res
) => {

    try {

        const {
            page,
            limit,
            skip,
        } = paginate(req);

        const {
            search,
            category,
            isActive,
            isSerialized,
        } = req.query;

        const filter = {};

        // Search Filter - matches name, productCode, or any model number
        if (search?.trim()) {

            const term = search.trim();

            filter.$or = [
                {
                    name: {
                        $regex: term,
                        $options: "i",
                    },
                },
                {
                    productCode: {
                        $regex: term,
                        $options: "i",
                    },
                },
                {
                    modelNumber: {
                        $regex: term,
                        $options: "i",
                    },
                },
            ];

        }

        // Category Filter
        if (category?.trim()) {

            filter.category =
                category
                    .trim()
                    .toUpperCase();

        }

        // Active/Inactive Filter - explicit string like the rest of the
        // project's list endpoints ("true"/"false"); omitted = show
        // everything, active and inactive alike.
        //
        // isDeleted is deliberately tied to this same filter rather than
        // always excluded: deleteProductController's "deactivate" sets
        // both isActive:false and isDeleted:true together (this app has
        // no hard-delete, so isDeleted here just means "deactivated via
        // the dedicated endpoint" rather than "gone forever"). Always
        // hiding isDeleted:true would make deactivated products
        // undiscoverable/unreactivatable from the list, even under
        // "show inactive too".
        if (isActive === "true") {
            filter.isActive = true;
            filter.isDeleted = false;
        } else if (isActive === "false") {
            filter.isActive = false;
            // isDeleted intentionally not filtered here - both
            // deactivation paths (dedicated delete, or a plain update
            // that only flips isActive) count as "inactive".
        }
        // isActive omitted entirely -> no isActive/isDeleted filter at
        // all, i.e. truly everything.

        // Serialized/Non-serialized Filter
        if (isSerialized === "true") {
            filter.isSerialized = true;
        } else if (isSerialized === "false") {
            filter.isSerialized = false;
        }

        const products =
            await Product.find(filter)
                .populate(
                    "createdBy",
                    "name email role"
                )
                .sort({
                    createdAt: -1,
                })
                .skip(skip)
                .limit(limit);

        const total =
            await Product.countDocuments(
                filter
            );

        return successResponse(
            res,
            "Products retrieved successfully",
            {
                products,
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(
                        total / limit
                    ),
                },
            }
        );

    } catch (error) {

        console.error(
            "Error retrieving products:",
            error
        );

        return errorResponse(
            res,
            "Internal server error",
            500
        );

    }

};



