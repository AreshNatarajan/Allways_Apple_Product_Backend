import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import User from "../../models/User.js";
import bcrypt from "bcryptjs";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";

/**
 * Create Branch Admin
 * Only SUPER_ADMIN can create branch admins
 */
export const createAdminController = async (req, res) => {
    try {
        // ============================================================
        // 1. ROLE CHECK - Only SUPER_ADMIN
        // ============================================================
        if (req.user.role !== "SUPER_ADMIN") {
            return errorResponse(
                res,
                "Access denied. Only SUPER_ADMIN can create branch admins",
                403
            );
        }

        // ============================================================
        // 2. EXTRACT REQUEST BODY
        // ============================================================
        const {
            name,
            email,
            phone,
            profilePhoto,
            password,
            role,
            branchId,
            isActive
        } = req.body;

        // ============================================================
        // 3. VALIDATION - Required Fields
        // ============================================================
        if (!name || !name.trim()) {
            return errorResponse(res, "Admin name is required", 400);
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

        if (!branchId) {
            return errorResponse(res, "Branch ID is required", 400);
        }

        // ============================================================
        // 4. VALIDATE EMAIL FORMAT
        // ============================================================
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return errorResponse(res, "Please enter a valid email address", 400);
        }

        // ============================================================
        // 5. VALIDATE PHONE NUMBER (if provided)
        // ============================================================
        if (phone && phone.trim()) {
            const phoneRegex = /^[0-9]{10}$/;
            if (!phoneRegex.test(phone.trim())) {
                return errorResponse(res, "Please enter a valid 10-digit phone number", 400);
            }
        }

        // ============================================================
        // 6. CHECK BRANCH EXISTS AND IS ACTIVE
        // ============================================================
        const branchCheck = await resolveActiveBranch(branchId);
        if (branchCheck.error) {
            return errorResponse(res, branchCheck.error, branchCheck.error === "Branch not found" ? 404 : 400);
        }

        // ============================================================
        // 7. CHECK FOR DUPLICATE EMAIL
        // ============================================================
        const existingUser = await User.findOne({
            email: email.toLowerCase().trim(),
            isDeleted: false
        });

        if (existingUser) {
            return errorResponse(res, "User with this email already exists", 409);
        }

        // ============================================================
        // 8. HASH PASSWORD
        // ============================================================
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // ============================================================
        // 9. CREATE ADMIN USER - a branch can now have more than one
        // Branch Admin, so this deliberately does not check for an
        // existing one first.
        // ============================================================
        const admin = await User.create({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            phone: phone?.trim() || "",
            profilePhoto: profilePhoto || null,
            password: hashedPassword,
            role: "BRANCH_ADMIN",
            branchId: branchId,
            isActive: isActive !== undefined ? isActive : true,
            createdBy: req.user._id,
        });

        // ============================================================
        // 10. REMOVE SENSITIVE DATA FROM RESPONSE
        // ============================================================
        const adminResponse = {
            _id: admin._id,
            name: admin.name,
            email: admin.email,
            phone: admin.phone,
            profilePhoto: admin.profilePhoto,
            role: admin.role,
            branchId: admin.branchId,
            isActive: admin.isActive,
            createdAt: admin.createdAt,
            updatedAt: admin.updatedAt
        };

        return successResponse(
            res,
            "Branch Admin created successfully",
            adminResponse,
            201
        );

    } catch (error) {
        console.error("Create Admin Error:", error);
        
        // Handle duplicate key error
        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            return errorResponse(
                res,
                `${field} already exists. Please use a different ${field}.`,
                409
            );
        }

        return errorResponse(res, "Server error while creating admin", 500);
    }
};



