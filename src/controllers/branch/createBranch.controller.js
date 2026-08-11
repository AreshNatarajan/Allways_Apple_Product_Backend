import Branch from "../../models/Branch.modal.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

/**
 * Create Branch
 * Only SUPER_ADMIN
 */
export const createBranchController = async (req, res) => {
    try {
        // Role Check
        if (req.user.role !== "SUPER_ADMIN") {
            return errorResponse(
                res,
                "Access denied. Only SUPER_ADMIN can create branches",
                403
            );
        }

        const {
            name,
            code,
            email,
            phones,
            address,
            isActive,
        } = req.body;

        // Validation - Required fields
        if (!name || !code) {
            return errorResponse(
                res,
                "Branch name and code are required",
                400
            );
        }

        // Validate code format (letters/numbers only, 2-10 chars) -
        // matches the same rule enforced on update, so a branch can
        // never be created with a code that update would then reject.
        const codeRegex = /^[A-Z0-9]{2,10}$/;
        if (!codeRegex.test(code.trim().toUpperCase())) {
            return errorResponse(
                res,
                "Code must be 2-10 characters (uppercase letters and numbers only)",
                400
            );
        }

        // Validate email format if provided
        if (email && email.trim()) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email.trim())) {
                return errorResponse(res, "Please enter a valid email address", 400);
            }
        }

        // Validate each phone number (10 digits) if provided
        const phoneRegex = /^[0-9]{10}$/;
        const phoneNumbers = phones && Array.isArray(phones)
            ? phones.filter(phone => phone && phone.trim() !== "")
            : [];
        for (const phone of phoneNumbers) {
            if (!phoneRegex.test(phone.trim())) {
                return errorResponse(
                    res,
                    `Invalid phone number: ${phone}. Must be 10 digits.`,
                    400
                );
            }
        }

        // Check Branch Code Duplicate
        const existingBranch = await Branch.findOne({
            code: code.toUpperCase().trim(),
            isDeleted: false,
        });

        if (existingBranch) {
            return errorResponse(
                res,
                "Branch code already exists",
                409
            );
        }

        // Prepare address object
        const addressData = address ? {
            addressLine1: address.addressLine1 || "",
            addressLine2: address.addressLine2 || "",
            city: address.city || "",
            state: address.state || "",
            country: address.country || "India",
            pincode: address.pincode || "",
        } : {
            addressLine1: "",
            addressLine2: "",
            city: "",
            state: "",
            country: "India",
            pincode: "",
        };

        // Create Branch
        const branch = await Branch.create({
            name: name.trim(),
            code: code.toUpperCase().trim(),
            email: email?.trim() || "",
            phones: phoneNumbers,
            address: addressData,
            isActive: isActive !== undefined ? isActive : true,
            createdBy: req.user._id,
        });

        return successResponse(
            res,
            "Branch created successfully",
            {
                branch: {
                    id: branch._id,
                    name: branch.name,
                    code: branch.code,
                    email: branch.email,
                    phones: branch.phones,
                    address: branch.address,
                    isActive: branch.isActive,
                    createdAt: branch.createdAt,
                },
            },
            201
        );

    } catch (error) {
        console.error("Create Branch Error:", error);
        return errorResponse(
            res,
            "Server error",
            500
        );
    }
};

/**
 * Update Branch
 * Only SUPER_ADMIN
 */
export const updateBranchController = async (req, res) => {
    try {
        // Role Check
        if (req.user.role !== "SUPER_ADMIN") {
            return errorResponse(
                res,
                "Access denied. Only SUPER_ADMIN can update branches",
                403
            );
        }

        const { id } = req.params;
        const {
            name,
            code,
            email,
            phones,
            address,
            isActive,
        } = req.body;

        // Check if branch exists
        const branch = await Branch.findOne({
            _id: id,
            isDeleted: false,
        });

        if (!branch) {
            return errorResponse(
                res,
                "Branch not found",
                404
            );
        }

        // Prepare update data
        const updateData = {
            updatedBy: req.user._id,
        };

        if (name) updateData.name = name.trim();
        if (code) updateData.code = code.toUpperCase().trim();
        if (email !== undefined) updateData.email = email?.trim() || "";
        if (isActive !== undefined) updateData.isActive = isActive;
        
        // Update phones if provided
        if (phones && Array.isArray(phones)) {
            updateData.phones = phones.filter(phone => phone && phone.trim() !== "");
        }

        // Update address if provided
        if (address) {
            updateData.address = {
                addressLine1: address.addressLine1 || branch.address?.addressLine1 || "",
                addressLine2: address.addressLine2 || branch.address?.addressLine2 || "",
                city: address.city || branch.address?.city || "",
                state: address.state || branch.address?.state || "",
                country: address.country || branch.address?.country || "India",
                pincode: address.pincode || branch.address?.pincode || "",
            };
        }

        // Update branch
        const updatedBranch = await Branch.findByIdAndUpdate(
            id,
            updateData,
            { new: true, runValidators: true }
        );

        return successResponse(
            res,
            "Branch updated successfully",
            {
                branch: {
                    id: updatedBranch._id,
                    name: updatedBranch.name,
                    code: updatedBranch.code,
                    email: updatedBranch.email,
                    phones: updatedBranch.phones,
                    address: updatedBranch.address,
                    isActive: updatedBranch.isActive,
                    updatedAt: updatedBranch.updatedAt,
                },
            },
            200
        );

    } catch (error) {
        console.error("Update Branch Error:", error);
        return errorResponse(
            res,
            "Server error",
            500
        );
    }
};

/**
 * Get All Branches
 */
export const getAllBranchesController = async (req, res) => {
    try {
        const branches = await Branch.find({
            isDeleted: false,
        })
        .select("-__v")
        .sort({ createdAt: -1 });

        return successResponse(
            res,
            "Branches fetched successfully",
            branches,
            200
        );

    } catch (error) {
        console.error("Get All Branches Error:", error);
        return errorResponse(
            res,
            "Server error",
            500
        );
    }
};

/**
 * Get Branch by ID
 */
export const getBranchByIdController = async (req, res) => {
    try {
        const { id } = req.params;

        const branch = await Branch.findOne({
            _id: id,
            isDeleted: false,
        })
        .select("-__v");

        if (!branch) {
            return errorResponse(
                res,
                "Branch not found",
                404
            );
        }

        return successResponse(
            res,
            "Branch fetched successfully",
            branch,
            200
        );

    } catch (error) {
        console.error("Get Branch By ID Error:", error);
        return errorResponse(
            res,
            "Server error",
            500
        );
    }
};

/**
 * Soft Delete Branch
 */
export const deleteBranchController = async (req, res) => {
    try {
        // Role Check
        if (req.user.role !== "SUPER_ADMIN") {
            return errorResponse(
                res,
                "Access denied. Only SUPER_ADMIN can delete branches",
                403
            );
        }

        const { id } = req.params;

        const branch = await Branch.findOne({
            _id: id,
            isDeleted: false,
        });

        if (!branch) {
            return errorResponse(
                res,
                "Branch not found",
                404
            );
        }

        // Soft delete
        branch.isDeleted = true;
        branch.deletedAt = new Date();
        branch.updatedBy = req.user._id;
        await branch.save();

        return successResponse(
            res,
            "Branch deleted successfully",
            null,
            200
        );

    } catch (error) {
        console.error("Delete Branch Error:", error);
        return errorResponse(
            res,
            "Server error",
            500
        );
    }
};


