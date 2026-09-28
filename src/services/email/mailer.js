import nodemailer from "nodemailer";

// Single lazily-created transporter, reused across every send - created
// once on first use rather than at module-import time, so a missing
// EMAIL_USER/EMAIL_PASSWORD only breaks the actual email attempt, never
// the whole server's boot. Gmail's "service" shorthand handles the
// correct host/port/TLS itself, so only the account + app password
// (EMAIL_USER/EMAIL_PASSWORD, already in .env) are needed.
let transporter = null;

export const getMailTransporter = () => {
    if (transporter) return transporter;

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        throw new Error("EMAIL_USER/EMAIL_PASSWORD are not configured - cannot send email");
    }

    transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
        },
    });

    return transporter;
};
