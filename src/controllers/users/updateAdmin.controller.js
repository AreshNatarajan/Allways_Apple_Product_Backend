import mongoose from "mongoose";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import User from "../../models/User.js";
import bcrypt from "bcryptjs";


/**
 * Update Branch Admin
 * Only SUPER_ADMIN can update branch admins
 */
export const updateAdminController = async (req, res) => {
    try {
        // ============================================================
        // 1. ROLE CHECK - Only SUPER_ADMIN
        // ============================================================
        if (req.user.role !== "SUPER_ADMIN") {
            return errorResponse(
                res,
                "Access denied. Only SUPER_ADMIN can update branch admins",
                403
            );
        }

        // ============================================================
        // 2. EXTRACT REQUEST PARAMS AND BODY
        // ============================================================
        const { id } = req.params;
        const {
            name,
            email,
            phone,
            profilePhoto,
            password,
            isActive
        } = req.body;

        // ============================================================
        // 3. VALIDATE ADMIN ID
        // ============================================================
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid admin ID format", 400);
        }

        // ============================================================
        // 4. FIND ADMIN
        // ============================================================
        const admin = await User.findOne({
            _id: id,
            role: "BRANCH_ADMIN",
            isDeleted: false
        });

        if (!admin) {
            return errorResponse(res, "Branch Admin not found", 404);
        }

        // ============================================================
        // 5. BUILD UPDATE DATA
        // ============================================================
        const updateData = {
            updatedBy: req.user._id
        };

        // Update name if provided
        if (name && name.trim()) {
            updateData.name = name.trim();
        }

        // Update email if provided
        if (email && email.trim()) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return errorResponse(res, "Please enter a valid email address", 400);
            }

            // Check if email is taken by another user
            const existingUser = await User.findOne({
                email: email.toLowerCase().trim(),
                _id: { $ne: id },
                isDeleted: false
            });

            if (existingUser) {
                return errorResponse(res, "Email already in use by another user", 409);
            }

            updateData.email = email.toLowerCase().trim();
        }

        // Update phone if provided
        if (phone !== undefined) {
            if (phone && phone.trim()) {
                const phoneRegex = /^[0-9]{10}$/;
                if (!phoneRegex.test(phone.trim())) {
                    return errorResponse(res, "Please enter a valid 10-digit phone number", 400);
                }
                updateData.phone = phone.trim();
            } else {
                updateData.phone = "";
            }
        }

        // Update profile photo if provided
        if (profilePhoto !== undefined) {
            updateData.profilePhoto = profilePhoto || null;
        }

        // Update password if provided
        if (password && password.trim()) {
            if (password.length < 6) {
                return errorResponse(res, "Password must be at least 6 characters", 400);
            }
            const salt = await bcrypt.genSalt(10);
            updateData.password = await bcrypt.hash(password, salt);
            updateData.passwordChangedAt = new Date();
        }

        // Update active status if provided
        if (isActive !== undefined) {
            updateData.isActive = isActive;
        }

        // ============================================================
        // 6. UPDATE ADMIN
        // ============================================================
        const updatedAdmin = await User.findByIdAndUpdate(
            id,
            updateData,
            { new: true, runValidators: true }
        ).select('-password -passwordChangedAt -__v');

        // ============================================================
        // 7. RETURN RESPONSE
        // ============================================================
        return successResponse(
            res,
            "Branch Admin updated successfully",
            updatedAdmin,
            200
        );

    } catch (error) {
        console.error("Update Admin Error:", error);

        // Handle duplicate key error
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            return errorResponse(
                res,
                `${field} already exists. Please use a different ${field}.`,
                409
            );
        }

        return errorResponse(res, "Server error while updating admin", 500);
    }
};