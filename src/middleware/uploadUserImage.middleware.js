// Shared validation for User profile images and Branch logos.
//
// NOTE: this project mounts `express-fileupload` globally in server.js
// (`app.use(fileUpload())`), which consumes the multipart/form-data
// stream on every request before any route-level multer middleware can
// run - a second multer parse attempt on the same request always fails
// with "Unexpected end of form" (confirmed live while testing this
// phase). So these uploads are validated manually against the file
// object express-fileupload already put on req.files, matching the
// pattern the existing product-image upload path uses
// (fileUploadController.js / req.files.file), rather than introducing a
// second, conflicting multipart parser.

const ALLOWED_MIME_TYPES = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
];

export const MIME_TO_EXTENSION = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
};

// Windows (without a HEIC codec pack installed) and some browsers report
// no mimetype at all, or a generic one like application/octet-stream,
// for a HEIC/HEIF file - the browser simply doesn't know what it is.
// Relying on file.mimetype alone would then reject a genuine HEIC/HEIF
// upload outright. This is used only as a narrow fallback SIGNAL for
// whether to accept the file and which extension to store it under -
// never for anything filename-derived beyond this fixed allowlist (no
// path traversal risk: the stored key is still always built server-side
// from ids/timestamps/random bytes, never the client's filename itself).
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "heic", "heif"];

const extensionFromName = (name) => {
    const ext = (name || "").split(".").pop()?.toLowerCase();
    return ALLOWED_EXTENSIONS.includes(ext) ? ext : null;
};

export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Validate an express-fileupload file object.
 * Returns an error message string if invalid, or null if valid.
 */
export const validateImageFile = (file) => {
    if (!file) {
        return "No image file uploaded";
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype) && !extensionFromName(file.name)) {
        return "Only JPG, JPEG, PNG, WEBP, HEIC or HEIF images are allowed";
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
        return "Image must be 5MB or smaller";
    }

    return null;
};

/**
 * The extension to store an already-validated file under. Prefers the
 * mimetype mapping; falls back to the file's own (allowlist-checked)
 * extension when the mimetype was missing/generic - see the HEIC/HEIF
 * note above. Only ever call this after validateImageFile() has passed.
 */
export const resolveImageExtension = (file) =>
    MIME_TO_EXTENSION[file.mimetype] || extensionFromName(file.name) || "jpg";
