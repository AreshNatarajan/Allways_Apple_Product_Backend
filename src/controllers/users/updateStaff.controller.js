// controllers/staff/updateStaff.controller.js
import mongoose from "mongoose";
import User from "../../models/User.js";
import bcrypt from "bcryptjs";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";

export const updateStaffController = async (req, res) => {
    try {
        const { id: staffId } = req.params;
        const {
            name,
            email,
            phone,
            profilePhoto,
            password,
            branchId,
            isActive,
        } = req.body;

        const loggedInUser = req.user;

        // ============================================================
        // ✅ VALIDATION
        // ============================================================

        if (!staffId) {
            return errorResponse(res, "Staff ID is required", 400);
        }

        if (!mongoose.Types.ObjectId.isValid(staffId)) {
            return errorResponse(res, "Invalid staff ID", 400);
        }

        // Check if staff exists
        const staff = await User.findOne({
            _id: staffId,
            role: "STAFF",
            isDeleted: false,
        });

        if (!staff) {
            return errorResponse(res, "Staff not found", 404);
        }

        // Validate email if being updated
        if (email && email.trim()) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return errorResponse(res, "Please enter a valid email address", 400);
            }

            // Check if email already exists for another user
            const existingUser = await User.findOne({
                email: email.toLowerCase().trim(),
                isDeleted: false,
                _id: { $ne: staffId },
            });

            if (existingUser) {
                return errorResponse(res, "User with this email already exists", 409);
            }
        }

        // Validate phone if provided
        if (phone && !/^[0-9]{10}$/.test(phone)) {
            return errorResponse(res, "Please enter a valid 10-digit phone number", 400);
        }

        // Validate password if provided
        if (password && password.length < 6) {
            return errorResponse(res, "Password must be at least 6 characters", 400);
        }

        // ============================================================
        // ✅ CHECK PERMISSIONS
        // ============================================================

        // Route is SUPER_ADMIN-only (see user.router.js); this check is a
        // defensive backstop in case the controller is ever wired up
        // elsewhere without the onlySuperAdmin middleware.
        if (!loggedInUser || loggedInUser.role !== "SUPER_ADMIN") {
            return errorResponse(res, "You don't have permission to update staff", 403);
        }

        // ============================================================
        // ✅ PREPARE UPDATE DATA
        // ============================================================

        const updateData = {};

        if (name && name.trim()) {
            updateData.name = name.trim();
        }

        if (email && email.trim()) {
            updateData.email = email.toLowerCase().trim();
        }

        if (phone !== undefined) {
            updateData.phone = phone || "";
        }

        if (profilePhoto !== undefined) {
            updateData.profilePhoto = profilePhoto || null;
        }

        if (password) {
            updateData.password = await bcrypt.hash(password, 10);
            updateData.passwordChangedAt = new Date();
        }

        if (isActive !== undefined) {
            updateData.isActive = isActive;
        }

        if (branchId && branchId !== staff.branchId.toString()) {
            // Only SUPER_ADMIN can change branch
            if (loggedInUser.role !== "SUPER_ADMIN") {
                return errorResponse(res, "Only SUPER_ADMIN can change staff branch", 403);
            }

            // The target branch must actually exist and be active - a
            // valid ObjectId shape alone is not sufficient.
            const branchCheck = await resolveActiveBranch(branchId);
            if (branchCheck.error) {
                return errorResponse(res, branchCheck.error, branchCheck.error === "Branch not found" ? 404 : 400);
            }

            updateData.branchId = branchId;
        }

        updateData.updatedBy = loggedInUser._id;

        // ============================================================
        // ✅ UPDATE STAFF
        // ============================================================

        const updatedStaff = await User.findByIdAndUpdate(
            staffId,
            updateData,
            { new: true, runValidators: true }
        );

        // ============================================================
        // ✅ RESPONSE
        // ============================================================

        const staffResponse = updatedStaff.toObject();
        delete staffResponse.password;

        return successResponse(
            res,
            "Staff updated successfully",
            {
                staff: staffResponse,
            }
        );

    } catch (error) {
        console.error("❌ Update Staff Error:", error);
        return errorResponse(res, "Failed to update staff", 500);
    }
};