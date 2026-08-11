// controllers/vendor/getVendorOptions.controller.js
import Vendor from "../../models/Vendor.modal.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getVendorOptionsController = async (req, res) => {
    try {
        const { search = "" } = req.query;

        // ✅ Build query - Global vendors (no branch filter)
        const query = {
            isDeleted: false,
            isActive: true,
        };

        // ✅ Search filter
        if (search && search.trim()) {
            const searchRegex = new RegExp(search.trim(), "i");
            query.$or = [
                { name: { $regex: searchRegex } },
                { phone: { $regex: searchRegex } },
                { email: { $regex: searchRegex } },
                { contactPerson: { $regex: searchRegex } },
                { gstNumber: { $regex: searchRegex } },
            ];
        }

        // ✅ Get vendors with selected fields
        const vendors = await Vendor.find(query, {
            name: 1,
            phone: 1,
            email: 1,
            contactPerson: 1,
            gstNumber: 1,
            address: 1,
            isActive: 1,
        })
            .sort({ name: 1 })
            .limit(20);

        // ✅ Transform data for dropdown
        const transformedVendors = vendors.map(vendor => ({
            _id: vendor._id,
            name: vendor.name,
            phone: vendor.phone,
            email: vendor.email,
            contactPerson: vendor.contactPerson,
            gstNumber: vendor.gstNumber,
            address: vendor.address,
            isActive: vendor.isActive,
            displayName: `${vendor.name}${vendor.phone ? ` (${vendor.phone})` : ''}`,
        }));

        return successResponse(
            res,
            "Vendors retrieved successfully",
            transformedVendors
        );

    } catch (error) {
        console.error("Get Vendor Options Error:", error);
        return errorResponse(
            res,
            "Internal server error",
            500
        );
    }
};


