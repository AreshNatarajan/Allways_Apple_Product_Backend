// services/pdfGenerator.service.js
import fs from "fs";
import path from "path";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ Configure paths
const INVOICE_PATH = path.join(__dirname, '../../src/uploads/invoices');
const LOGO_PATH = path.join(__dirname, '../../src/assets/logo.png');
const SIGNATURE_PATH = path.join(__dirname, '../../src/uploads/signatures');

// ✅ Ensure directories exist
if (!fs.existsSync(INVOICE_PATH)) {
    fs.mkdirSync(INVOICE_PATH, { recursive: true });
}
if (!fs.existsSync(SIGNATURE_PATH)) {
    fs.mkdirSync(SIGNATURE_PATH, { recursive: true });
}

// jsPDF's core Helvetica font can't reliably render non-Latin glyphs
// (₹, د.إ) - an ASCII-safe text prefix per currency keeps every PDF
// renderable regardless of which currency is configured, mirroring the
// same "Rs."-not-"₹" choice this file already made for INR.
const PDF_SAFE_CURRENCY_PREFIX = {
    INR: "Rs.",
    USD: "$",
    EUR: "EUR ",
    GBP: "GBP ",
    AED: "AED ",
};

const hexToRgb = (hex) => {
    const clean = (hex || "").replace("#", "");
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const num = parseInt(full, 16);
    if (Number.isNaN(num) || full.length !== 6) return [30, 60, 150]; // fallback: original NAVY default
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
};

class PDFPurchaseGeneratorService {
    /**
     * Convert image to base64
     */
    static imageToBase64(imagePath) {
        try {
            if (!fs.existsSync(imagePath)) {
                return null;
            }
            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');
            const ext = path.extname(imagePath).toLowerCase();
            const mimeType = ext === '.png' ? 'image/png' : 
                            ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 
                            ext === '.gif' ? 'image/gif' : 'image/png';
            return `data:${mimeType};base64,${base64Image}`;
        } catch (error) {
            console.error('Error converting image to base64:', error);
            return null;
        }
    }

    /**
     * Generate Purchase Invoice PDF with Logo & Signature.
     * Visual design (layout/header/spacing/fonts/borders/table style/
     * alignment/section placement/total-payment sections) modeled on a
     * reference physical invoice supplied by the business. Purchase
     * data, fields, and calculations are unchanged - this method only
     * changed how they're drawn.
     *
     * `settings` ({ headerColor, currencyCode }) is read fresh from
     * Global Settings by the caller at generation time only - this PDF
     * is generated once and stored in S3 (see
     * services/purchase/generatePurchaseInvoicePdf.js), so a later
     * settings change can never retroactively alter an already-created
     * invoice, only new ones going forward. Company identity (name/
     * address/phone/email/GSTIN) is not part of Global Settings in
     * this app - always the fixed values below.
     */
    static generatePurchasePDF(purchase, settings = {}) {
        return new Promise((resolve, reject) => {
            try {
                const doc = new jsPDF();

                const NAVY = hexToRgb(settings.headerColor);
                const CUR = PDF_SAFE_CURRENCY_PREFIX[settings.currencyCode] || PDF_SAFE_CURRENCY_PREFIX.INR;
                const COMPANY_NAME = "Always Apple Products";
                const BLACK = [0, 0, 0];
                const GRAY = [110, 110, 110];
                const TABLE_HEADER_FILL = [172, 160, 150];
                const PAID_COLOR = [0, 140, 60];
                const PARTIAL_COLOR = [220, 140, 0];
                const PENDING_COLOR = [200, 30, 30];

                const LEFT = 15;
                const RIGHT = 195;
                const PAGE_CENTER = 105;

                // =====================
                // HEADER: title top-left, logo top-right
                // =====================
                doc.setFontSize(16);
                doc.setFont("helvetica", "bold");
                doc.setTextColor(...NAVY);
                doc.text("P U R C H A S E   I N V O I C E", LEFT, 18);
                doc.setTextColor(...BLACK);

                const logoBase64 = this.imageToBase64(LOGO_PATH);
                if (logoBase64) {
                    try {
                        doc.addImage(logoBase64, 'PNG', RIGHT - 20, 10, 20, 20);
                    } catch (error) {
                        console.error('Error adding logo:', error);
                    }
                }

                // =====================
                // COMPANY DETAILS
                // =====================
                // Address/phone/email come from the purchase's own
                // branch (BRANCH_ADMIN direct-receive purchases always
                // have one) - a CENTRAL purchase has no single branch to
                // print, so it falls back to a generic default instead.
                const branch = purchase.branchId;
                const branchAddr = branch?.address;
                const hasBranchAddress = !!(branchAddr && (branchAddr.addressLine1 || branchAddr.city));

                let addressLine1, addressLine2, phoneText, emailText, branchSubtitle;
                if (hasBranchAddress) {
                    addressLine1 = [branchAddr.addressLine1, branchAddr.addressLine2].filter(Boolean).join(", ") || "-";
                    addressLine2 = [branchAddr.city, branchAddr.state, branchAddr.country].filter(Boolean).join(", ")
                        + (branchAddr.pincode ? ` - ${branchAddr.pincode}` : "");
                    phoneText = (branch.phones && branch.phones.length > 0) ? branch.phones.join(", ") : "-";
                    emailText = branch.email || "-";
                    branchSubtitle = branch.name ? `(${branch.name} Branch)` : "";
                } else {
                    addressLine1 = "No 169, 22nd Avenue Banu Nagar,";
                    addressLine2 = "Ambattur, Chennai, TAMIL NADU - 600053";
                    phoneText = "+91 9876543210";
                    emailText = "info@alwaysapple.com";
                    branchSubtitle = "";
                }

                let y = 28;
                doc.setFontSize(15);
                doc.setFont("helvetica", "bold");
                doc.text(COMPANY_NAME, LEFT, y);
                // Measure at the font size it was actually just drawn
                // at, before switching size/weight for the subtitle -
                // measuring after the switch under-measures and makes
                // the two overlap.
                const companyNameWidth = doc.getTextWidth(COMPANY_NAME);
                if (branchSubtitle) {
                    doc.setFontSize(10);
                    doc.setFont("helvetica", "normal");
                    doc.setTextColor(...GRAY);
                    doc.text(branchSubtitle, LEFT + companyNameWidth + 4, y);
                    doc.setTextColor(...BLACK);
                }

                y += 6;
                doc.setFontSize(9);
                doc.setFont("helvetica", "normal");
                doc.text(addressLine1, LEFT, y);
                y += 4.5;
                doc.text(addressLine2, LEFT, y);
                y += 5.5;
                doc.setFont("helvetica", "bold");
                doc.text("Phone", LEFT, y);
                doc.setFont("helvetica", "normal");
                doc.text(` ${phoneText}`, LEFT + 10, y);
                doc.setFont("helvetica", "bold");
                doc.text("Email", LEFT + 60, y);
                doc.setFont("helvetica", "normal");
                doc.text(` ${emailText}`, LEFT + 70, y);

                y += 6;
                doc.setDrawColor(180, 180, 180);
                doc.setLineWidth(0.3);
                doc.line(LEFT, y, RIGHT, y);

                // =====================
                // PURCHASE NO / DATE
                // =====================
                y += 8;
                doc.setFontSize(10);
                doc.setFont("helvetica", "bold");
                doc.text("Purchase No:", LEFT, y);
                doc.setFont("helvetica", "bold");
                doc.text(purchase.purchaseNumber || "-", LEFT + 28, y);

                doc.setFont("helvetica", "bold");
                doc.text("Purchase Date:", 120, y);
                doc.setFont("helvetica", "bold");
                doc.text(
                    purchase.purchaseDate ? new Date(purchase.purchaseDate).toLocaleDateString("en-IN") : "-",
                    150, y
                );

                // =====================
                // VENDOR DETAILS (equivalent of "Customer Details" on
                // the reference - who we bought from, not who we sold
                // to)
                // =====================
                y += 10;
                doc.setFontSize(10);
                doc.setFont("helvetica", "normal");
                doc.setTextColor(...GRAY);
                doc.text("Vendor Details:", LEFT, y);
                doc.setTextColor(...BLACK);

                const vendor = purchase.vendorId || {};
                y += 6;
                doc.setFontSize(12);
                doc.setFont("helvetica", "bold");
                doc.text(vendor.name || "-", LEFT, y);

                doc.setFontSize(9);
                doc.setFont("helvetica", "normal");
                if (vendor.phone) {
                    y += 6;
                    doc.setFont("helvetica", "bold");
                    doc.text("Phone No:", LEFT, y);
                    doc.setFont("helvetica", "normal");
                    doc.text(` ${vendor.phone}`, LEFT + 20, y);
                }
                if (vendor.email) {
                    y += 5.5;
                    doc.setFont("helvetica", "bold");
                    doc.text("Email:", LEFT, y);
                    doc.setFont("helvetica", "normal");
                    doc.text(` ${vendor.email}`, LEFT + 20, y);
                }
                if (vendor.address) {
                    y += 5.5;
                    doc.setFont("helvetica", "bold");
                    doc.text("Address:", LEFT, y);
                    doc.setFont("helvetica", "normal");
                    doc.text(` ${vendor.address}`, LEFT + 20, y);
                }

                // =====================
                // ITEMS TABLE
                // =====================
                const headers = [
                    "Product Name", "Model", "Serial Number", "Description",
                    "Qty", "HSN/SAC", "GST %", "GST Amount", "Total Amount",
                ];

                const body = purchase.items.map((item) => {
                    const isSerializedRow = item.serialNumbers && item.serialNumbers.length > 0;
                    const productName = item.productId?.name || "-";
                    // Model is the exact per-unit value the purchaser
                    // entered (attached in-memory by the caller, sourced
                    // from ProductSerial - never applicable to
                    // non-serialized lines). Description comes from the
                    // Product master.
                    const model = item.modelNumber || "-";
                    const serialNo = isSerializedRow ? item.serialNumbers[0].serialNumber : "-";
                    const description = item.productId?.description || "-";
                    const qty = item.quantity || 0;
                    const hsn = item.hsnCode || item.productId?.hsnCode || "-";
                    // Serialized units carry no purchase-time GST by
                    // business rule - "-" is more honest than "0%" here.
                    const gstPercentDisplay = isSerializedRow ? "-" : `${item.purchaseGstPercent || 0}%`;
                    const gstAmountDisplay = isSerializedRow ? "-" : `${CUR}${(item.purchaseGstAmount || 0).toLocaleString()}`;
                    const totalDisplay = `${CUR}${(item.totalPrice || 0).toLocaleString()}`;

                    return [productName, model, serialNo, description, qty, hsn, gstPercentDisplay, gstAmountDisplay, totalDisplay];
                });

                autoTable(doc, {
                    startY: y + 8,
                    head: [headers],
                    body,
                    theme: "grid",
                    styles: {
                        lineColor: [130, 130, 130],
                        lineWidth: 0.2,
                    },
                    headStyles: {
                        fillColor: TABLE_HEADER_FILL,
                        textColor: BLACK,
                        fontStyle: "bold",
                        fontSize: 8,
                        halign: "center",
                    },
                    bodyStyles: {
                        fontSize: 8,
                        textColor: BLACK,
                    },
                    columnStyles: {
                        0: { halign: "left" },
                        1: { halign: "center" },
                        2: { halign: "center" },
                        3: { halign: "left" },
                        4: { halign: "center", cellWidth: 12 },
                        5: { halign: "center" },
                        6: { halign: "center" },
                        7: { halign: "right" },
                        8: { halign: "right" },
                    },
                });

                // =====================
                // TOTAL (right-aligned, thin rule above - matches the
                // reference's Total treatment)
                // =====================
                const tableEndY = doc.lastAutoTable.finalY;
                let bandY = tableEndY + 10;

                doc.setDrawColor(80, 80, 80);
                doc.setLineWidth(0.4);
                doc.line(130, bandY - 6, RIGHT, bandY - 6);

                doc.setFont("times", "bold");
                doc.setFontSize(12);
                doc.text("Total", 130, bandY);
                doc.text(`${CUR}${(purchase.totalAmount || 0).toLocaleString()}`, RIGHT, bandY, { align: "right" });
                doc.setFont("helvetica", "normal");

                // Total items / qty, left side, same band as the payment badge
                bandY += 8;
                const totalItems = purchase.items.length;
                const totalQty = purchase.items.reduce((sum, it) => sum + (it.quantity || 0), 0);
                doc.setFontSize(9);
                doc.setTextColor(...GRAY);
                doc.text(`Total Items / Qty : ${totalItems} / ${totalQty}`, LEFT, bandY);
                doc.setTextColor(...BLACK);

                doc.setDrawColor(60, 100, 200);
                doc.line(LEFT, bandY + 2, RIGHT, bandY + 2);

                // Payment status badge (color-coded, matches reference's
                // green checkmark + "Paid" treatment)
                const paymentStatus = purchase.paymentStatus || "PENDING";
                const badgeColor = paymentStatus === "PAID" ? PAID_COLOR
                    : paymentStatus === "PARTIAL" ? PARTIAL_COLOR
                    : PENDING_COLOR;
                bandY += 8;
                doc.setFillColor(...badgeColor);
                doc.circle(RIGHT - 22, bandY - 1.5, 2, "F");
                doc.setFont("helvetica", "bold");
                doc.setFontSize(10);
                doc.setTextColor(...badgeColor);
                doc.text(paymentStatus.charAt(0) + paymentStatus.slice(1).toLowerCase(), RIGHT - 18, bandY, { align: "left" });
                doc.setTextColor(...BLACK);
                doc.setFont("helvetica", "normal");

                // =====================
                // PAYMENT DETAILS (left) + SIGNATURE (right) - same
                // horizontal band, mirroring the reference's
                // bank-details-left / signature-right layout
                // =====================
                let leftY = bandY + 12;
                const sectionTopY = leftY;

                doc.setFontSize(11);
                doc.setFont("helvetica", "bold");
                doc.text("Payment Details", LEFT, leftY);
                leftY += 7;

                doc.setFontSize(9);
                doc.setFont("helvetica", "normal");
                if (purchase.paymentDetails && purchase.paymentDetails.length > 0) {
                    purchase.paymentDetails.forEach((payment) => {
                        const method = payment.paymentMethod || "CASH";
                        const amount = payment.amount || 0;
                        const date = payment.paymentDate ? new Date(payment.paymentDate).toLocaleDateString("en-IN") : "-";
                        doc.setFont("helvetica", "bold");
                        doc.text(method, LEFT, leftY);
                        doc.setFont("helvetica", "normal");
                        doc.text(`: ${CUR}${amount.toLocaleString()}  (${date})`, LEFT + 22, leftY);
                        leftY += 5.5;
                    });
                } else {
                    doc.text("No payment details recorded", LEFT, leftY);
                    leftY += 5.5;
                }

                leftY += 3;
                doc.setFont("helvetica", "bold");
                doc.text("Paid Amount:", LEFT, leftY);
                doc.setFont("helvetica", "normal");
                doc.text(` ${CUR}${(purchase.paidAmount || 0).toLocaleString()}`, LEFT + 25, leftY);
                leftY += 5.5;
                doc.setFont("helvetica", "bold");
                doc.text("Pending Amount:", LEFT, leftY);
                doc.setFont("helvetica", "normal");
                doc.text(` ${CUR}${(purchase.pendingAmount || 0).toLocaleString()}`, LEFT + 30, leftY);
                leftY += 8;

                // Signature block, right side, same band as payment details
                const sigBoxX = 140;
                const sigBoxY = sectionTopY - 4;
                doc.setFontSize(9);
                doc.setFont("helvetica", "normal");
                doc.text(`For ${COMPANY_NAME}`, sigBoxX, sigBoxY);

                doc.setDrawColor(200, 200, 200);
                doc.setLineWidth(0.4);
                doc.rect(sigBoxX, sigBoxY + 3, 45, 26);

                let signatureAdded = false;
                if (purchase.signatureFile) {
                    try {
                        const signatureFileName = path.basename(purchase.signatureFile);
                        const signatureFilePath = path.join(SIGNATURE_PATH, signatureFileName);
                        if (fs.existsSync(signatureFilePath)) {
                            const signatureBase64 = this.imageToBase64(signatureFilePath);
                            if (signatureBase64) {
                                doc.addImage(signatureBase64, 'PNG', sigBoxX + 3, sigBoxY + 5, 39, 20);
                                signatureAdded = true;
                            }
                        }
                    } catch (error) {
                        console.error('Error adding signature to PDF:', error);
                    }
                }
                if (!signatureAdded) {
                    doc.setFontSize(8);
                    doc.setFont("helvetica", "italic");
                    doc.setTextColor(...GRAY);
                    doc.text("No signature available", sigBoxX + 22.5, sigBoxY + 16, { align: "center" });
                    doc.setTextColor(...BLACK);
                }
                doc.setFontSize(9);
                doc.setFont("helvetica", "bold");
                doc.text("Authorized Signatory", sigBoxX + 22.5, sigBoxY + 33, { align: "center" });
                doc.setFont("helvetica", "normal");

                // =====================
                // NOTES
                // =====================
                let noteY = Math.max(leftY, sigBoxY + 40) + 8;
                if (purchase.notes) {
                    doc.setFontSize(10);
                    doc.setFont("helvetica", "bold");
                    doc.text("Note:", LEFT, noteY);
                    noteY += 5.5;
                    doc.setFontSize(9);
                    doc.setFont("helvetica", "normal");
                    const splitNotes = doc.splitTextToSize(purchase.notes, RIGHT - LEFT);
                    doc.text(splitNotes, LEFT, noteY);
                }

                // =====================
                // FOOTER
                // =====================
                doc.setFontSize(8);
                doc.setFont("helvetica", "italic");
                doc.setTextColor(...GRAY);
                doc.text(
                    "This is a system-generated purchase invoice.",
                    PAGE_CENTER, 285, { align: "center" }
                );
                doc.text(
                    `Generated on: ${new Date().toLocaleString()}`,
                    PAGE_CENTER, 290, { align: "center" }
                );
                doc.setTextColor(...BLACK);

                // =====================
                // GENERATE PDF BUFFER (in-memory only - callers that
                // need persistence upload this buffer to S3 themselves,
                // e.g. services/purchase/generatePurchaseInvoicePdf.js)
                // =====================
                const pdfBuffer = doc.output('arraybuffer');
                const fileName = `${purchase.purchaseNumber || 'purchase'}-${Date.now()}.pdf`;

                resolve({
                    fileName,
                    buffer: Buffer.from(pdfBuffer),
                });

            } catch (error) {
                console.error('PDF Generation Error:', error);
                reject(error);
            }
        });
    }

    /**
     * Delete invoice file
     */
    static deleteInvoiceFile(fileName) {
        try {
            if (!fileName) return false;
            const filePath = path.join(INVOICE_PATH, fileName);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error deleting invoice file:', error);
            return false;
        }
    }

    /**
     * Get invoice file path
     */
    static getInvoicePath(fileName) {
        return path.join(INVOICE_PATH, fileName);
    }

    /**
     * Check if invoice exists
     */
    static invoiceExists(fileName) {
        if (!fileName) return false;
        const filePath = path.join(INVOICE_PATH, fileName);
        return fs.existsSync(filePath);
    }
}

export default PDFPurchaseGeneratorService;

