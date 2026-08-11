import { verifyToken } from '../../utils/jwtHandler.js';
import LoginHistory from '../../models/LoginHistory.model.js';
import {
    successResponse,
    errorResponse,
} from '../../utils/responseHandler.js';

// Closes out the caller's own session only (matched by the sessionId
// embedded in their JWT), not "most recently opened", since a user can
// have more than one active session across devices/tabs.
export const logoutController = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return errorResponse(res, 'Unauthorized: No token provided', 401);
        }

        const token = authHeader.split(' ')[1];
        const decoded = verifyToken(token);

        if (!decoded || !decoded.sid) {
            return errorResponse(res, 'Unauthorized: Invalid or expired token', 401);
        }

        await LoginHistory.findOneAndUpdate(
            {
                userId: req.user._id,
                sessionId: decoded.sid,
                logoutAt: null,
            },
            {
                logoutAt: new Date(),
            }
        );

        return successResponse(res, 'Logout successful', null, 200);

    } catch (error) {
        console.error('Logout Error:', error);
        return errorResponse(res, 'Internal Server Error', 500);
    }
};
