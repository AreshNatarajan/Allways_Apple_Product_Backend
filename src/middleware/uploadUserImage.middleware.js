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
];

export const MIME_TO_EXTENSION = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
};

export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Validate an express-fileupload file object.
 * Returns an error message string if invalid, or null if valid.
 * Never trusts the client-supplied file.name for anything.
 */
export const validateImageFile = (file) => {
    if (!file) {
        return "No image file uploaded";
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        return "Only JPG, JPEG, PNG and WEBP images are allowed";
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
        return "Image must be 5MB or smaller";
    }

    return null;
};
