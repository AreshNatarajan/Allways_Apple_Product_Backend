import { errorResponse } from "../utils/responseHandler.js";

// Minimal in-memory, per-IP fixed-window limiter for public endpoints
// that take a guessable-length credential (the short invoice code).
// Per process - good enough to make guessing codes pointless; it is not
// a general-purpose limiter. req.ip is the real client because
// server.js sets `trust proxy`.
const rateLimit = ({ windowMs, max, message = "Too many requests - please try again in a few minutes." }) => {
    const hits = new Map();

    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
    }, windowMs);
    sweep.unref?.();

    return (req, res, next) => {
        const now = Date.now();
        const ip = req.ip || "unknown";
        let entry = hits.get(ip);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(ip, entry);
        }
        entry.count += 1;
        if (entry.count > max) {
            res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
            return errorResponse(res, message, 429);
        }
        next();
    };
};

export default rateLimit;
