// socket/index.js
import { Server } from "socket.io";
import { verifyToken } from "../utils/jwtHandler.js";
import User from "../models/User.js";

// Minimal Socket.IO setup - one authenticated room per user
// ("user:<userId>"), nothing more. Every notification is already
// resolved to an exact list of recipient User ids server-side (see
// services/notification/resolveTransferRecipients.js) BEFORE anything
// reaches this module, so the socket layer never has to know about
// roles/branches/Transfers at all - it just pushes one event to one
// room per recipient. This is deliberately NOT a broadcast: no
// io.emit()/io.sockets.emit() anywhere in this app - only
// io.to('user:<id>').emit(...), so an unrelated branch's browser tab
// never receives another branch's Transfer notification even though
// it's connected to the same socket server.
let io = null;

export const initSocket = (httpServer, allowedOrigins) => {
    io = new Server(httpServer, {
        cors: {
            origin: allowedOrigins,
            credentials: true,
        },
    });

    // Same trust boundary as authMiddleware.js: a real, currently-valid
    // JWT for an active, non-deleted user - never a client-supplied
    // userId/role/branchId. Rejected connections never reach `connection`
    // at all (Socket.IO calls the client's connect_error handler instead).
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (!token) return next(new Error("Unauthorized: No token provided"));

            const decoded = verifyToken(token);
            if (!decoded) return next(new Error("Unauthorized: Invalid or expired token"));

            const user = await User.findById(decoded.userId).select("_id role branchId isActive isDeleted");
            if (!user || user.isDeleted || !user.isActive) {
                return next(new Error("Unauthorized: User not found"));
            }

            socket.userId = String(user._id);
            next();
        } catch (error) {
            console.error("Socket auth error:", error);
            next(new Error("Unauthorized"));
        }
    });

    io.on("connection", (socket) => {
        socket.join(`user:${socket.userId}`);

        socket.on("disconnect", () => {
            // Rooms are cleaned up automatically by Socket.IO on
            // disconnect - nothing to do here.
        });
    });

    console.log("Socket.IO initialized");
    return io;
};

// Used by services/controllers to emit - throws loudly if called before
// initSocket() so a missing wire-up fails fast in development instead of
// silently dropping every notification's real-time delivery.
export const getIO = () => {
    if (!io) {
        throw new Error("Socket.IO has not been initialized yet - call initSocket(httpServer) first");
    }
    return io;
};

// The room name convention, in one place so notifyTransferEvent and any
// future emitter never have to restate the "user:<id>" string literal.
export const userRoom = (userId) => `user:${userId}`;
