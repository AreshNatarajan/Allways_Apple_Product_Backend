// controllers/staff/createStaff.controller.js
import mongoose from "mongoose";
import User from "../../models/User.js";
import bcrypt from "bcryptjs";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";

export const createStaffController = async (req, res) => {
    try {
        const {
            name,
            email,
            phone,
            profilePhoto,
            password,
            branchId,
            isActive = true,
        } = req.body;

        const loggedInUser = req.user;

        // ============================================================
        // ✅ VALIDATION
        // ============================================================

        // Check required fields
        if (!name || !name.trim()) {
            return errorResponse(res, "Staff name is required", 400);
        }

        if (!email || !email.trim()) {
            return errorResponse(res, "Email is required", 400);
        }

        if (!password) {
            return errorResponse(res, "Password is required", 400);
        }

        if (password.length < 6) {
            return errorResponse(res, "Password must be at least 6 characters", 400);
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return errorResponse(res, "Please enter a valid email address", 400);
        }

        // Validate phone number if provided
        if (phone && !/^[0-9]{10}$/.test(phone)) {
            return errorResponse(res, "Please enter a valid 10-digit phone number", 400);
        }

        // Validate branchId - STAFF must belong to a branch that
        // actually exists and is currently active. A valid ObjectId
        // shape alone is not sufficient.
        const branchCheck = await resolveActiveBranch(branchId);
        if (branchCheck.error) {
            return errorResponse(res, branchCheck.error, branchCheck.error === "Branch not found" ? 404 : 400);
        }

        // ============================================================
        // ✅ CHECK PERMISSIONS
        // ============================================================

        // Route is SUPER_ADMIN-only (see user.router.js); this check is a
        // defensive backstop in case the controller is ever wired up
        // elsewhere without the onlySuperAdmin middleware.
        if (!loggedInUser || loggedInUser.role !== "SUPER_ADMIN") {
            return errorResponse(res, "You don't have permission to create staff", 403);
        }

        // ============================================================
        // ✅ CHECK DUPLICATES
        // ============================================================

        // Check if email already exists
        const existingUser = await User.findOne({ 
            email: email.toLowerCase().trim(),
            isDeleted: false,
        });

        if (existingUser) {
            return errorResponse(res, "User with this email already exists", 409);
        }

        // ============================================================
        // ✅ HASH PASSWORD
        // ============================================================

        const hashedPassword = await bcrypt.hash(password, 10);

        // ============================================================
        // ✅ CREATE STAFF
        // ============================================================

        const staff = await User.create({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            phone: phone || "",
            profilePhoto: profilePhoto || null,
            password: hashedPassword,
            role: "STAFF",
            branchId: branchId,
            isActive: isActive,
            isDeleted: false,
            createdBy: loggedInUser._id,
        });

        // ============================================================
        // ✅ RESPONSE
        // ============================================================

        // Remove password from response
        const staffResponse = staff.toObject();
        delete staffResponse.password;

        return successResponse(
            res,
            "Staff created successfully",
            {
                staff: {
                    ...staffResponse,
                    branchId: staffResponse.branchId,
                }
            },
            201
        );

    } catch (error) {
        console.error("❌ Create Staff Error:", error);
        return errorResponse(res, "Failed to create staff", 500);
    }
};