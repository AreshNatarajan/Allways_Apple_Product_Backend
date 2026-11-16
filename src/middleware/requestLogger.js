// middleware/requestLogger.js
//
// Dev-only terminal logging: one line per request (method, path, status,
// time) and, for any response with status >= 400, the error message the
// API sent back. Never logs request bodies, headers, cookies or tokens
// (so passwords/JWTs can't leak into the terminal). Off when
// NODE_ENV === "production" or LOG_REQUESTS === "false".
const enabled = () => process.env.NODE_ENV !== "production" && process.env.LOG_REQUESTS !== "false";

// Query strings can carry search terms / ids - keep only the path.
const cleanPath = (url) => String(url || "").split("?")[0];

export const requestLogger = (req, res, next) => {
  if (!enabled()) return next();
  const start = process.hrtime.bigint();
  let errorMessage = "";

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body === "object") {
      errorMessage = String(body.message || body.error || "").slice(0, 300);
    }
    return originalJson(body);
  };

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.statusCode;
    const line = `[REQ] ${req.method} ${cleanPath(req.originalUrl)} -> ${status} (${ms.toFixed(0)}ms)`;
    if (status >= 400) console.error(`[ERR] ${line.slice(6)}${errorMessage ? ` | ${errorMessage}` : ""}`);
    else console.log(line);
  });

  next();
};

// Last-resort process-level errors, so a crash reason always reaches the terminal.
export const registerProcessErrorLogging = () => {
  process.on("unhandledRejection", (reason) => console.error("[ERR] Unhandled promise rejection:", reason));
  process.on("uncaughtException", (err) => console.error("[ERR] Uncaught exception:", err));
};
