import mongoose from "mongoose";
import Branch from "../../models/Branch.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

/**
 * Update Branch
 * Only SUPER_ADMIN can update branches
 */
export const updateBranchController = async (req, res) => {
    try {
        // ============================================================
        // 1. ROLE CHECK - Only SUPER_ADMIN
        // ============================================================
        if (req.user.role !== "SUPER_ADMIN") {
            return errorResponse(
                res,
                "Access denied. Only SUPER_ADMIN can update branches",
                403
            );
        }


        console.log("Update Branch Request Body:", req.body);

        // ============================================================
        // 2. EXTRACT REQUEST PARAMS AND BODY
        // ============================================================
        const { id } = req.params;


        const {
            name,
            code,
            email,
            phones,
            address,
            bankDetails,
            googleMapUrl,
            isActive
        } = req.body;


        

        // ============================================================
        // 3. VALIDATE BRANCH ID
        // ============================================================
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid branch ID format", 400);
        }

        // ============================================================
        // 4. FIND BRANCH
        // ============================================================
        const branch = await Branch.findOne({
            _id: id,
            isDeleted: false
        });

        if (!branch) {
            return errorResponse(res, "Branch not found", 404);
        }

        // ============================================================
        // 5. BUILD UPDATE DATA
        // ============================================================
        const updateData = {
            updatedBy: req.user._id
        };

        // Update name if provided
        if (name !== undefined) {
            if (!name || !name.trim()) {
                return errorResponse(res, "Branch name is required", 400);
            }
            updateData.name = name.trim();
        }

        // Update code if provided
        if (code !== undefined) {
            if (!code || !code.trim()) {
                return errorResponse(res, "Branch code is required", 400);
            }

            const codeRegex = /^[A-Z0-9]{2,10}$/;
            if (!codeRegex.test(code.trim().toUpperCase())) {
                return errorResponse(
                    res,
                    "Code must be 2-10 characters (uppercase letters and numbers only)",
                    400
                );
            }

            // Check if code is taken by another branch
            const existingBranch = await Branch.findOne({
                code: code.trim().toUpperCase(),
                _id: { $ne: id },
                isDeleted: false
            });

            if (existingBranch) {
                return errorResponse(res, "Branch code already exists", 409);
            }

            updateData.code = code.trim().toUpperCase();
        }

        // Update email if provided
        if (email !== undefined) {
            if (email && email.trim()) {
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(email)) {
                    return errorResponse(res, "Please enter a valid email address", 400);
                }
                updateData.email = email.trim().toLowerCase();
            } else {
                updateData.email = "";
            }
        }

        // Update phones if provided
        if (phones !== undefined) {
            if (!Array.isArray(phones)) {
                return errorResponse(res, "Phones must be an array", 400);
            }

            // Filter empty phone numbers and validate
            const validPhones = phones.filter(phone => phone && phone.trim() !== "");
            
            // Validate each phone number (10 digits)
            const phoneRegex = /^[0-9]{10}$/;
            for (const phone of validPhones) {
                if (!phoneRegex.test(phone.trim())) {
                    return errorResponse(
                        res,
                        `Invalid phone number: ${phone}. Must be 10 digits.`,
                        400
                    );
                }
            }

            updateData.phones = validPhones.map(phone => phone.trim());
        }

        // Update address if provided
        if (address !== undefined) {
            if (typeof address !== 'object') {
                return errorResponse(res, "Address must be an object", 400);
            }

            updateData.address = {
                addressLine1: address.addressLine1?.trim() || branch.address?.addressLine1 || "",
                addressLine2: address.addressLine2?.trim() || branch.address?.addressLine2 || "",
                city: address.city?.trim() || branch.address?.city || "",
                state: address.state?.trim() || branch.address?.state || "",
                country: address.country?.trim() || branch.address?.country || "India",
                pincode: address.pincode?.trim() || branch.address?.pincode || ""
            };
        }

        // Update bank details if provided - partial merge onto existing
        // values, same pattern as address above (never wipes a field
        // the caller didn't send).
        if (bankDetails !== undefined) {
            if (typeof bankDetails !== 'object' || bankDetails === null) {
                return errorResponse(res, "Bank details must be an object", 400);
            }

            const nextIfscCode = (bankDetails.ifscCode?.trim().toUpperCase()) || branch.bankDetails?.ifscCode || "";
            if (nextIfscCode) {
                const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
                if (!ifscRegex.test(nextIfscCode)) {
                    return errorResponse(res, "Invalid IFSC code format", 400);
                }
            }

            updateData.bankDetails = {
                accountHolderName: bankDetails.accountHolderName?.trim() || branch.bankDetails?.accountHolderName || "",
                bankName: bankDetails.bankName?.trim() || branch.bankDetails?.bankName || "",
                accountNumber: bankDetails.accountNumber?.trim() || branch.bankDetails?.accountNumber || "",
                ifscCode: nextIfscCode,
                bankBranch: bankDetails.bankBranch?.trim() || branch.bankDetails?.bankBranch || "",
            };
        }

        // Update Google Maps link if provided
        if (googleMapUrl !== undefined) {
            const trimmedMapUrl = googleMapUrl ? googleMapUrl.trim() : "";
            if (trimmedMapUrl && !/^https?:\/\//i.test(trimmedMapUrl)) {
                return errorResponse(res, "Google Map URL must start with http:// or https://", 400);
            }
            updateData.googleMapUrl = trimmedMapUrl;
        }

        // Update active status if provided
        if (isActive !== undefined) {
            if (typeof isActive !== 'boolean') {
                return errorResponse(res, "isActive must be a boolean value", 400);
            }
            updateData.isActive = isActive;
        }

        // ============================================================
        // 6. UPDATE BRANCH
        // ============================================================
        const updatedBranch = await Branch.findByIdAndUpdate(
            id,
            updateData,
            { new: true, runValidators: true }
        )
        .populate('createdBy', '_id name email role')
        .populate('updatedBy', '_id name email role')
        .lean();

        // ============================================================
        // 7. RETURN RESPONSE
        // ============================================================
        return successResponse(
            res,
            "Branch updated successfully",
            {
                _id: updatedBranch._id,
                name: updatedBranch.name,
                code: updatedBranch.code,
                logo: updatedBranch.logo,
                email: updatedBranch.email,
                phones: updatedBranch.phones,
                address: updatedBranch.address,
                bankDetails: updatedBranch.bankDetails,
                upiQrImage: updatedBranch.upiQrImage,
                googleMapUrl: updatedBranch.googleMapUrl,
                isActive: updatedBranch.isActive,
                createdAt: updatedBranch.createdAt,
                updatedAt: updatedBranch.updatedAt,
                createdBy: updatedBranch.createdBy,
                updatedBy: updatedBranch.updatedBy
            },
            200
        );

    } catch (error) {
        console.error("Update Branch Error:", error);

        // Handle duplicate key error
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            return errorResponse(
                res,
                `${field} already exists. Please use a different ${field}.`,
                409
            );
        }

        return errorResponse(res, "Server error while updating branch", 500);
    }
};