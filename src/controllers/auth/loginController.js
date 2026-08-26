import crypto from 'crypto';
import User from '../../models/User.js';
import LoginHistory from '../../models/LoginHistory.model.js';
import bcrypt from 'bcryptjs';

import { generateToken } from '../../utils/jwtHandler.js';

import {
    successResponse,
    errorResponse,
} from '../../utils/responseHandler.js';

const getClientIp = (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || '';
};

export const loginController = async (
    req,
    res
) => {
    try {

        const {
            phone,
            password,
        } = req.body;

        if (
            !phone ||
            !password
        ) {
            return errorResponse(
                res,
                'Phone number and password are required',
                400
            );
        }

        // Same trim-based normalization user-creation already applies to
        // phone (see creatStaff.controller.js et al.) - no other format
        // variance exists in real data (verified: every stored phone is a
        // plain 10-digit string, no +91/spaces/dashes), so trim is enough.
        const normalizedPhone = phone.trim();

        const user =
            await User.findOne({
                phone: normalizedPhone,
            });

        if (!user) {
            return errorResponse(
                res,
                'Invalid phone number or password',
                401
            );
        }

        if (user.isDeleted) {
            return errorResponse(
                res,
                'Invalid phone number or password',
                401
            );
        }

        if (!user.isActive) {
            return errorResponse(
                res,
                'User account is inactive',
                403
            );
        }

        // COMPARE PASSWORD
        const isPasswordValid =
            await bcrypt.compare(
                password,
                user.password
            );

        if (!isPasswordValid) {
            return errorResponse(
                res,
                'Invalid phone number or password',
                401
            );
        }

        const sessionId = crypto.randomUUID();

        const token =
            generateToken({
                userId: user._id,
                sid: sessionId,
            });

        // Best-effort audit trail; do not fail login if this write fails.
        try {
            await LoginHistory.create({
                userId: user._id,
                role: user.role,
                branchId: user.branchId || null,
                sessionId,
                ipAddress: getClientIp(req),
                userAgent: req.headers['user-agent'] || '',
            });
        } catch (historyError) {
            console.error('Login History Create Error:', historyError);
        }

        user.lastLoginAt = new Date();
        await user.save();

        return successResponse(
            res,
            'Login successful',
            {
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    branchId:
                        user.branchId,
                    isActive:
                        user.isActive,
                    permissions:
                        user.permissions,
                },
                token,
            },
            200
        );

    } catch (error) {

        console.error(
            'Error in loginController:',
            error
        );

        return errorResponse(
            res,
            'Internal Server Error',
            500
        );
    }
};
