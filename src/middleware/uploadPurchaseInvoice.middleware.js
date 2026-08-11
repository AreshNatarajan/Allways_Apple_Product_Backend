// Validation for the vendor-invoice PDF upload on Purchase Create.
//
// This used to be a route-level multer instance, but this project mounts
// express-fileupload globally in server.js (app.use(fileUpload())), which
// consumes the multipart/form-data stream before any route-level multer
// middleware can run - a second multer parse on the same request always
// fails with "Unexpected end of form" (same failure mode already
// documented on uploadUserImage.middleware.js for the image uploads).
// This endpoint was live but broken as a result. Fixed to validate the
// file express-fileupload already put on req.files, matching every other
// working upload path in this app (branch logo, profile image, product
// images), and to upload to S3 via putObject instead of local disk.

const MAX_INVOICE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

/**
 * Validate an express-fileupload file object for the vendor invoice PDF.
 * Returns an error message string if invalid, or null if valid.
 */
export const validateInvoicePdf = (file) => {
    if (!file) {
        return "Invoice PDF is required";
    }

    if (file.mimetype !== "application/pdf") {
        return "Only PDF files are allowed";
    }

    if (file.size > MAX_INVOICE_SIZE_BYTES) {
        return "Invoice PDF must be 10MB or smaller";
    }

    return null;
};
