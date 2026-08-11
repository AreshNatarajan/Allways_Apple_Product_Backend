import User from "../models/User.js";

import { verifyToken } from "../utils/jwtHandler.js";

import {
    errorResponse,
} from "../utils/responseHandler.js";

/**
 * Authentication Middleware
 * Protect Private Routes
 */
const authMiddleware = async (
    req,
    res,
    next
) => {

    try {

        const authHeader =
            req.headers.authorization;

        /**
         * Check Authorization Header
         */
        if (
            !authHeader ||
            !authHeader.startsWith("Bearer ")
        ) {

            return errorResponse(
                res,
                "Unauthorized: No token provided",
                401
            );

        }

        /**
         * Extract Token
         */
        const token =
            authHeader.split(" ")[1];

        /**
         * Verify Token
         */
        const decoded =
            verifyToken(token);

        if (!decoded) {

            return errorResponse(
                res,
                "Unauthorized: Invalid or expired token",
                401
            );

        }

        /**
         * Get User Details
         */
        const user =
            await User.findById(
                decoded.userId
            ).select("-password");

        if (!user) {

            return errorResponse(
                res,
                "Unauthorized: User not found",
                401
            );

        }

        /**
         * Check User Status
         */
        if (user.isDeleted) {

            return errorResponse(
                res,
                "Unauthorized: User not found",
                401
            );

        }

        if (!user.isActive) {

            return errorResponse(
                res,
                "Account is inactive",
                403
            );

        }

        /**
         * Attach User To Request
         */
        req.user = user;

        req.userId = user._id;

        next();

    } catch (error) {

        console.error(
            "Auth Middleware Error:",
            error
        );

        return errorResponse(
            res,
            "Internal Server Error during authentication",
            500
        );

    }

};

export default authMiddleware;