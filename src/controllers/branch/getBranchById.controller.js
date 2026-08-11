import mongoose from "mongoose";
import Branch from "../../models/Branch.modal.js";
import User from "../../models/User.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getBranchByIdController = async (req, res) => {
    try {
        const { id } = req.params;
        const authenticatedUser = req.user;

        // Validate ObjectId
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(
                res,
                "Invalid branch ID format",
                400
            );
        }

        // ============================================================
        // 1. ROLE-BASED BRANCH ACCESS CONTROL
        // ============================================================
        
        let branchIdToFetch = id;

        // Check if user is SUPER_ADMIN
        if (authenticatedUser.role === "SUPER_ADMIN") {
            // SUPER_ADMIN can access any branch
            // Use the ID from params
            branchIdToFetch = id;
        } 
        // Check if user is BRANCH_ADMIN or STAFF
        else if (
            authenticatedUser.role === "BRANCH_ADMIN" || 
            authenticatedUser.role === "STAFF"
        ) {
            // BRANCH_ADMIN and STAFF can ONLY access their own branch
            if (id !== authenticatedUser.branchId?.toString()) {
                return errorResponse(
                    res,
                    "Access denied. You can only access your assigned branch.",
                    403
                );
            }
            branchIdToFetch = authenticatedUser.branchId;
        } 
        // Any other role
        else {
            return errorResponse(
                res,
                "Access denied. Insufficient permissions.",
                403
            );
        }

        // ============================================================
        // 2. FETCH BRANCH
        // ============================================================
        
        const branch = await Branch.findOne({
            _id: branchIdToFetch,
            isDeleted: false
        })
        .populate('createdBy', '_id name email role profilePhoto')
        .populate('updatedBy', '_id name email role profilePhoto')
        .lean();

        if (!branch) {
            return errorResponse(
                res,
                "Branch not found",
                404
            );
        }

        // ============================================================
        // 3. FETCH ALL USERS FOR THIS BRANCH
        // ============================================================
        
        const users = await User.find({
            branchId: branch._id,
            isDeleted: false
        })
        .select('-password -passwordChangedAt -__v')
        .populate('createdBy', '_id name email role profilePhoto')
        .populate('updatedBy', '_id name email role profilePhoto')
        .lean();

        // ============================================================
        // 4. SEPARATE ADMIN AND STAFF
        // ============================================================
        
        let branchAdmin = null;
        const staffUsers = [];

        users.forEach(user => {
            if (user.role === "BRANCH_ADMIN") {
                branchAdmin = user;
            } else if (user.role === "STAFF") {
                staffUsers.push(user);
            }
        });

        // ============================================================
        // 5. PREPARE RESPONSE DATA
        // ============================================================
        
        const responseData = {
            branch: {
                _id: branch._id,
                name: branch.name,
                code: branch.code,
                logo: branch.logo,
                email: branch.email,
                phones: branch.phones || [],
                address: {
                    addressLine1: branch.address?.addressLine1 || "",
                    addressLine2: branch.address?.addressLine2 || "",
                    city: branch.address?.city || "",
                    state: branch.address?.state || "",
                    country: branch.address?.country || "India",
                    pincode: branch.address?.pincode || ""
                },
                bankDetails: {
                    accountHolderName: branch.bankDetails?.accountHolderName || "",
                    bankName: branch.bankDetails?.bankName || "",
                    accountNumber: branch.bankDetails?.accountNumber || "",
                    ifscCode: branch.bankDetails?.ifscCode || "",
                    bankBranch: branch.bankDetails?.bankBranch || "",
                },
                upiQrImage: branch.upiQrImage || null,
                googleMapUrl: branch.googleMapUrl || "",
                isActive: branch.isActive,
                createdAt: branch.createdAt,
                updatedAt: branch.updatedAt,
                createdBy: branch.createdBy || null,
                updatedBy: branch.updatedBy || null
            },
            users: {
                admin: branchAdmin ? {
                    _id: branchAdmin._id,
                    name: branchAdmin.name,
                    email: branchAdmin.email,
                    phone: branchAdmin.phone || "",
                    profilePhoto: branchAdmin.profilePhoto || null,
                    role: branchAdmin.role,
                    branchId: branchAdmin.branchId,
                    isActive: branchAdmin.isActive,
                    lastLoginAt: branchAdmin.lastLoginAt || null,
                    createdAt: branchAdmin.createdAt,
                    updatedAt: branchAdmin.updatedAt,
                    createdBy: branchAdmin.createdBy || null,
                    updatedBy: branchAdmin.updatedBy || null
                } : null,
                staff: staffUsers.map(staff => ({
                    _id: staff._id,
                    name: staff.name,
                    email: staff.email,
                    phone: staff.phone || "",
                    profilePhoto: staff.profilePhoto || null,
                    role: staff.role,
                    branchId: staff.branchId,
                    isActive: staff.isActive,
                    lastLoginAt: staff.lastLoginAt || null,
                    createdAt: staff.createdAt,
                    updatedAt: staff.updatedAt,
                    createdBy: staff.createdBy || null,
                    updatedBy: staff.updatedBy || null
                }))
            },
            // Include user role in response for frontend to determine UI
            userRole: authenticatedUser.role,
            userBranchId: authenticatedUser.branchId
        };

        return successResponse(
            res,
            "Branch details retrieved successfully",
            responseData,
            200
        );

    } catch (error) {
        console.error("Get Branch By ID Error:", error);
        
        // Handle specific MongoDB errors
        if (error.name === "CastError") {
            return errorResponse(
                res,
                "Invalid branch ID format",
                400
            );
        }

        return errorResponse(
            res,
            "Server error while fetching branch details",
            500
        );
    }
};



// import Branch from "../../models/Branch.modal";
// import User from "../../models/User.js";

// import {
//     successResponse,
//     errorResponse,
// } from "../../utils/responseHandler.js";

// export const getBranchByIdController = async (req, res) => {



// }