// Generic document validator - for attachments that are business
// documents (GST certificate, agreement, ID proof, invoice copy) rather
// than pure photos, so unlike uploadUserImage.middleware.js this also
// allows PDF and Word docs alongside the same image types. First
// consumer: Vendor attachments (uploadVendorAttachments.controller.js).
const ALLOWED_MIME_TYPES = [
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

const MIME_TO_EXTENSION = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

// Same reasoning as uploadUserImage.middleware.js's extensionFromName -
// some browsers/OSes report no mimetype (or a generic one) for certain
// files, so this is a narrow fallback signal for accept/extension only,
// never used for anything else filename-derived (the stored S3 key is
// still always built server-side from ids/timestamps/random bytes).
const ALLOWED_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "webp", "heic", "heif", "doc", "docx"];

const extensionFromName = (name) => {
    const ext = (name || "").split(".").pop()?.toLowerCase();
    return ALLOWED_EXTENSIONS.includes(ext) ? ext : null;
};

export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10MB - larger than the 5MB image-only cap, since scanned documents/PDFs run bigger

export const validateDocumentFile = (file) => {
    if (!file) {
        return "No file uploaded";
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype) && !extensionFromName(file.name)) {
        return "Only PDF, JPG, PNG, WEBP, HEIC/HEIF, DOC or DOCX files are allowed";
    }

    if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
        return "File must be 10MB or smaller";
    }

    return null;
};

export const resolveDocumentExtension = (file) =>
    MIME_TO_EXTENSION[file.mimetype] || extensionFromName(file.name) || "bin";
