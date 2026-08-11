import mongoose from "mongoose";
import User from "../../models/User.js";
import bcrypt from "bcryptjs";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";

const VALID_ROLES = ["SUPER_ADMIN", "BRANCH_ADMIN", "STAFF"];

/**
 * Generic user management endpoint - SUPER_ADMIN only.
 * Handles profile edits, password reset, activate/deactivate, role
 * change, and branch reassignment in one place, since those fields are
 * interdependent (role <-> branchId requirement, branch-admin
 * uniqueness applies whether role or branchId changes).
 *
 * This also covers a SUPER_ADMIN editing their own account (id === req.user._id
 * is not a special case - it's just another user to this endpoint).
 */
export const manageUserController = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            name,
            email,
            phone,
            password,
            isActive,
            branchId,
            role,
        } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid user ID", 400);
        }

        const targetUser = await User.findOne({ _id: id, isDeleted: false });

        if (!targetUser) {
            return errorResponse(res, "User not found", 404);
        }

        const updateData = { updatedBy: req.user._id };

        // ============================================================
        // BASIC FIELDS
        // ============================================================

        if (name !== undefined) {
            if (!name || !name.trim()) {
                return errorResponse(res, "Name cannot be empty", 400);
            }
            updateData.name = name.trim();
        }

        if (email !== undefined) {
            if (!email || !email.trim()) {
                return errorResponse(res, "Email cannot be empty", 400);
            }
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return errorResponse(res, "Please enter a valid email address", 400);
            }
            const existingEmailUser = await User.findOne({
                email: email.toLowerCase().trim(),
                _id: { $ne: id },
                isDeleted: false,
            });
            if (existingEmailUser) {
                return errorResponse(res, "Email already in use by another user", 409);
            }
            updateData.email = email.toLowerCase().trim();
        }

        if (phone !== undefined) {
            if (phone && !/^[0-9]{10}$/.test(phone)) {
                return errorResponse(res, "Please enter a valid 10-digit phone number", 400);
            }
            updateData.phone = phone || "";
        }

        if (password !== undefined) {
            if (!password || password.length < 6) {
                return errorResponse(res, "Password must be at least 6 characters", 400);
            }
            updateData.password = await bcrypt.hash(password, 10);
            updateData.passwordChangedAt = new Date();
        }

        // ============================================================
        // ROLE / BRANCH INTERDEPENDENCY
        // ============================================================

        if (role !== undefined && !VALID_ROLES.includes(role)) {
            return errorResponse(res, "Invalid role", 400);
        }

        const effectiveRole = role !== undefined ? role : targetUser.role;
        const effectiveIsActive = isActive !== undefined ? isActive : targetUser.isActive;
        const effectiveBranchId =
            branchId !== undefined
                ? branchId
                : (targetUser.branchId ? targetUser.branchId.toString() : null);

        // Guard: never allow the last remaining active SUPER_ADMIN to be
        // demoted or deactivated - would permanently lock out admin
        // access, since the public registration bootstrap only re-opens
        // when zero SUPER_ADMIN accounts exist.
        if (targetUser.role === "SUPER_ADMIN" && targetUser.isActive) {
            const wouldStopBeingActiveSuperAdmin =
                effectiveRole !== "SUPER_ADMIN" || effectiveIsActive === false;

            if (wouldStopBeingActiveSuperAdmin) {
                const activeSuperAdminCount = await User.countDocuments({
                    role: "SUPER_ADMIN",
                    isActive: true,
                    isDeleted: false,
                });
                if (activeSuperAdminCount <= 1) {
                    return errorResponse(
                        res,
                        "Cannot remove or deactivate the last remaining active SUPER_ADMIN",
                        409
                    );
                }
            }
        }

        if (effectiveRole === "STAFF" || effectiveRole === "BRANCH_ADMIN") {
            if (!effectiveBranchId) {
                return errorResponse(res, "Branch ID is required for this role", 400);
            }
            // The branch must actually exist and be active - a valid
            // ObjectId shape alone is not sufficient.
            const branchCheck = await resolveActiveBranch(effectiveBranchId);
            if (branchCheck.error) {
                return errorResponse(res, branchCheck.error, branchCheck.error === "Branch not found" ? 404 : 400);
            }
        }

        if (effectiveRole === "BRANCH_ADMIN") {
            const existingAdmin = await User.findOne({
                branchId: effectiveBranchId,
                role: "BRANCH_ADMIN",
                isDeleted: false,
                _id: { $ne: id },
            });
            if (existingAdmin) {
                return errorResponse(
                    res,
                    "This branch already has a Branch Admin assigned",
                    409
                );
            }
        }

        if (role !== undefined) {
            updateData.role = role;
        }

        if (effectiveRole === "SUPER_ADMIN") {
            // SUPER_ADMIN is global, never branch-scoped.
            if (branchId !== undefined || role !== undefined) {
                updateData.branchId = null;
            }
        } else if (branchId !== undefined) {
            updateData.branchId = effectiveBranchId;
        }

        if (isActive !== undefined) {
            updateData.isActive = isActive;
        }

        // ============================================================
        // APPLY UPDATE
        // ============================================================

        const updatedUser = await User.findByIdAndUpdate(
            id,
            updateData,
            { new: true, runValidators: true }
        ).select("-password -passwordChangedAt -__v");

        return successResponse(
            res,
            "User updated successfully",
            updatedUser,
            200
        );

    } catch (error) {
        console.error("Manage User Error:", error);

        if (error.code === 11000) {
            const field = Object.keys(error.keyPattern)[0];
            return errorResponse(
                res,
                `${field} already exists. Please use a different ${field}.`,
                409
            );
        }

        return errorResponse(res, "Server error while updating user", 500);
    }
};
