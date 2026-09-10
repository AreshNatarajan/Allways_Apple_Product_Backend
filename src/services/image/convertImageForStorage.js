import convert from "heic-convert";

// No browser except Safari can decode/render HEIC/HEIF in an <img> tag -
// every other image format this app stores is directly browser-viewable
// as-is, so this keeps that same guarantee true for HEIC/HEIF instead of
// silently storing a file nothing but Safari (or a download) can ever
// display. heic-convert wraps libheif-js (WASM) - no native build step,
// works the same on every platform this app runs on.
const HEIC_MIMETYPES = ["image/heic", "image/heif"];
const HEIC_EXTENSIONS = ["heic", "heif"];

const extensionFromName = (name) => (name || "").split(".").pop()?.toLowerCase();

const isHeic = (file) =>
    HEIC_MIMETYPES.includes(file.mimetype) || HEIC_EXTENSIONS.includes(extensionFromName(file.name));

/**
 * Converts a HEIC/HEIF upload to JPEG before it ever reaches S3. Every
 * other format passes through completely untouched.
 *
 * Returns { data, mimetype, extension } - always use these three
 * together (never the original file.data/file.mimetype/the extension
 * argument passed in) when building the S3 storage key and calling
 * putObject, so the stored bytes, the S3 Content-Type, and the file
 * extension in the key always agree with each other.
 *
 * Throws if the file claims to be HEIC/HEIF but isn't actually
 * decodable (corrupt upload, or a HEIC variant libheif-js doesn't
 * support) - callers should catch this and return a 400, same as any
 * other validation failure, never a 500.
 */
export const convertImageForStorage = async (file, resolvedExtension) => {
    if (!isHeic(file)) {
        return { data: file.data, mimetype: file.mimetype || "application/octet-stream", extension: resolvedExtension };
    }

    const jpegBuffer = await convert({ buffer: file.data, format: "JPEG", quality: 0.9 });
    return { data: jpegBuffer, mimetype: "image/jpeg", extension: "jpg" };
};
