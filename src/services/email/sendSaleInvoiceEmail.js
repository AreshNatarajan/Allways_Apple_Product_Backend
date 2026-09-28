import { getMailTransporter } from "./mailer.js";
import { getIO, userRoom } from "../../socket/index.js";
import { resolveTransferRecipients } from "../notification/resolveTransferRecipients.js";

// Fired once, right after a sale's system invoice is first saved (see
// setSaleInvoiceFile.controller.js's non-regenerate path) - never on a
// later "Regenerate Invoice", and never awaited by the caller. A failed
// send must never fail that request or roll back systemInvoiceFile; it
// only logs and gives up, same "best-effort, log and move on" pattern
// this app already uses for PDF/S3 generation itself.
//
// Fetches the PDF itself (same public-S3-URL-fetch pattern as
// getGstInvoiceSignatureImage.controller.js) rather than trusting
// nodemailer's own remote-attachment fetching, which behaves
// inconsistently across environments.
//
// `branchId` is the sale's own branch - used only to push a live toast
// to that branch's own staff (+ SUPER_ADMIN) once the send actually
// finishes, via the existing Socket.IO layer (socket/index.js). This is
// deliberately NOT written to the Notification model/bell - that model
// is Transfer-only today (see Notification.modal.js's own scope note);
// this is a plain ephemeral event, nothing persisted, nothing to mark
// read, gone the moment it's shown. resolveTransferRecipients is reused
// as-is for this since its actual logic ("SUPER_ADMIN + this branch's
// active users") has nothing Transfer-specific about it.
// `customerLink` is accepted but deliberately NOT included in the email
// body below - the customer-link feature (Sale Detail's own "Copy Link"
// button, the token/public-API foundation) stays fully intact, this
// only holds back showing the link IN THE EMAIL specifically until
// that's ready to ship as its own feature. Still passed through so the
// caller (setSaleInvoiceFile.controller.js) needs no change, and so
// re-adding the line back is a one-line change here when that's ready.
export const sendSaleInvoiceEmail = async ({ to, customerName, saleNumber, totalAmount, invoiceUrl, branchId, customerLink, branchPhone }) => {
    let sent = false;
    try {
        if (!to) {
            console.warn(`Sale invoice email skipped for ${saleNumber} - customer has no email on file`);
            return;
        }

        const upstream = await fetch(invoiceUrl);
        if (!upstream.ok) {
            throw new Error(`Failed to fetch invoice PDF (HTTP ${upstream.status})`);
        }
        const buffer = Buffer.from(await upstream.arrayBuffer());

        const greetingName = customerName || "Customer";
        const amountText = (Number(totalAmount) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const phoneLine = branchPhone || "";

        const transporter = getMailTransporter();
        await transporter.sendMail({
            from: `"Always Apple Products" <${process.env.EMAIL_USER}>`,
            to,
            subject: `Your Invoice ${saleNumber} - Always Apple Products`,
            text: `Hello ${greetingName},\n\nThanks for your business!.\n\nInvoice: ${saleNumber}\nTotal: Rs. ${amountText}\n\nThanks\nAlways Apple Products\n${phoneLine}`,
            html: `<p>Hello <b>${greetingName}</b>,</p>` +
                `<p>Thanks for your business!.</p>` +
                `<p><b>Invoice:</b> ${saleNumber}<br/>` +
                `<b>Total:</b> ₹${amountText}</p>` +
                `<p>Thanks<br/><b>Always Apple Products</b><br/><b>${phoneLine}</b></p>`,
            attachments: [
                {
                    filename: `${saleNumber}.pdf`,
                    content: buffer,
                    contentType: "application/pdf",
                },
            ],
        });

        sent = true;
        console.log(`Sale invoice email sent to ${to} for ${saleNumber}`);
    } catch (error) {
        console.error(`Sale invoice email failed for ${saleNumber}:`, error);
    }

    if (sent) {
        await notifyBranchInvoiceEmailSent({ saleNumber, to, branchId });
    }
};

// Best-effort live toast only - never awaited by the caller, never
// throws outward. A branch with no connected socket (nobody has the app
// open) simply sees nothing; there is no missed-event replay for this,
// unlike the persisted Notification model.
const notifyBranchInvoiceEmailSent = async ({ saleNumber, to, branchId }) => {
    try {
        const recipients = await resolveTransferRecipients(branchId ? [branchId] : []);
        if (recipients.length === 0) return;

        const io = getIO();
        const payload = { saleNumber, message: `Invoice email sent to ${to} for ${saleNumber}` };
        for (const recipient of recipients) {
            io.to(userRoom(recipient._id)).emit("sale-invoice-email:sent", payload);
        }
    } catch (error) {
        console.error(`Sale invoice email toast failed for ${saleNumber}:`, error);
    }
};
