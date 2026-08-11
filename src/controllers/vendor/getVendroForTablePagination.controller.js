// controllers/vendor/getVendorForTablePagination.js
import Vendor from "../../models/Vendor.modal.js";
import paginate from "../../utils/pagination.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getVendorForTablePagination = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { search, isActive, includeInactive } = req.query;

        // ✅ No branch filter - all vendors visible to everyone (global master)
        const filter = {};

        // Active/Inactive filter - explicit "true"/"false" string, same
        // convention as Product/Branch. Default (nothing specified)
        // preserves the endpoint's original active-only behavior so any
        // existing caller that never sent this param is unaffected.
        // `includeInactive=true` (or an explicit isActive=false) is the
        // signal to also surface inactive/deactivated vendors.
        //
        // isDeleted is tied to isActive:false / includeInactive rather
        // than always excluded: this app has no hard-delete, so a
        // deactivated vendor (isDeleted:true) must still be
        // discoverable/reactivatable, not just isActive:false docs.
        if (isActive === "true") {
            filter.isActive = true;
            filter.isDeleted = false;
        } else if (isActive === "false") {
            filter.isActive = false;
        } else if (includeInactive === "true") {
            // show everything, active and inactive alike
        } else {
            filter.isActive = true;
            filter.isDeleted = false;
        }

        // ✅ SEARCH
        if (search?.trim()) {
            const trimmedSearch = search.trim();
            filter.$or = [
                { name: { $regex: trimmedSearch, $options: "i" } },
                { contactPerson: { $regex: trimmedSearch, $options: "i" } },
                { phone: { $regex: trimmedSearch, $options: "i" } },
                { email: { $regex: trimmedSearch, $options: "i" } },
                { gstNumber: { $regex: trimmedSearch, $options: "i" } },
            ];
        }

        const vendors = await Vendor.find(filter)
            .populate("createdBy", "name email role")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const total = await Vendor.countDocuments(filter);

        return successResponse(res, "Vendors retrieved successfully", {
            vendors,
            pagination: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error("Get Vendors Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve vendors", 500);
    }
};



