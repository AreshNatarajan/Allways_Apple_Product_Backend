import crypto from 'crypto';
import User from '../../models/User.js';
import LoginHistory from '../../models/LoginHistory.model.js';
import bcrypt from 'bcryptjs';

import { generateToken } from '../../utils/jwtHandler.js';

import {
    successResponse,
    errorResponse,
} from '../../utils/responseHandler.js';

// This route is the only mechanism in the codebase for creating the very
// first SUPER_ADMIN account (no seed script exists). It stays open ONLY
// until that first SUPER_ADMIN exists, and only ever creates a
// SUPER_ADMIN - it never honors a client-supplied role/branchId. Once a
// SUPER_ADMIN exists, all further account creation must go through the
// SUPER_ADMIN-only endpoints under /user, and this route rejects outright.
export const registerController = async (
    req,
    res
) => {
    try {

        const {
            name,
            email,
            password,
        } = req.body;

        if (
            !name ||
            !email ||
            !password
        ) {
            return errorResponse(
                res,
                'All fields are required',
                400
            );
        }

        const existingSuperAdmin = await User.countDocuments({
            role: 'SUPER_ADMIN',
            isDeleted: false,
        });

        if (existingSuperAdmin > 0) {
            return errorResponse(
                res,
                'Public registration is disabled. Contact your administrator.',
                403
            );
        }

        const existingUser =
            await User.findOne({
                email,
            });

        if (existingUser) {
            return errorResponse(
                res,
                'Email is already registered',
                409
            );
        }

        // HASH PASSWORD
        const hashedPassword =
            await bcrypt.hash(
                password,
                10
            );

        const newUser =
            await User.create({
                name,
                email,
                password:
                    hashedPassword,
                role: 'SUPER_ADMIN',
                branchId: null,
                isActive: true,
            });

        const sessionId = crypto.randomUUID();

        const token =
            generateToken({
                userId: newUser._id,
                sid: sessionId,
            });

        try {
            await LoginHistory.create({
                userId: newUser._id,
                role: newUser.role,
                branchId: null,
                sessionId,
                ipAddress: req.ip || '',
                userAgent: req.headers['user-agent'] || '',
            });
        } catch (historyError) {
            console.error('Login History Create Error:', historyError);
        }

        return successResponse(
            res,
            'Super Admin account created successfully',
            {
                user: {
                    id: newUser._id,
                    name: newUser.name,
                    email: newUser.email,
                    role: newUser.role,
                    branchId:
                        newUser.branchId,
                    isActive:
                        newUser.isActive,
                },
                token,
            },
            201
        );

    } catch (error) {

        console.error(
            'Error in registerController:',
            error
        );

        return errorResponse(
            res,
            'Internal Server Error',
            500
        );
    }
};
