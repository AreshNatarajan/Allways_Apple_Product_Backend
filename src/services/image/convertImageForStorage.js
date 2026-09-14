import convert from "heic-convert";
import sharp from "sharp";

// No browser except Safari can decode/render HEIC/HEIF in an <img> tag -
// every other image format this app stores is directly browser-viewable
// as-is, so this keeps that same guarantee true for HEIC/HEIF instead of
// silently storing a file nothing but Safari (or a download) can ever
// display. heic-convert wraps libheif-js (WASM) - no native build step,
// works the same on every platform this app runs on.
const HEIC_MIMETYPES = ["image/heic", "image/heif"];
const HEIC_EXTENSIONS = ["heic", "heif"];

// Only these raster types ever get resized/recompressed - PDFs, DOC/DOCX
// (vendor attachments allow both images and documents through this same
// function) and anything else pass through completely untouched.
const COMPRESSIBLE_MIMETYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

const DEFAULT_MAX_DIMENSION = 1920;
const DEFAULT_JPEG_QUALITY = 80;
const DEFAULT_WEBP_QUALITY = 80;

const extensionFromName = (name) => (name || "").split(".").pop()?.toLowerCase();

const isHeic = (file) =>
    HEIC_MIMETYPES.includes(file.mimetype) || HEIC_EXTENSIONS.includes(extensionFromName(file.name));

// Resizes (only ever shrinks, never enlarges - fit:"inside" +
// withoutEnlargement) and re-encodes a raster image to cut upload/
// storage/bandwidth size. A phone camera photo routinely arrives at
// 3-10MB / 12+ megapixels, far beyond anything this app ever displays
// (no gallery view anywhere gets close to 1920px). `.rotate()` with no
// args auto-orients from the EXIF orientation tag before resizing, and
// sharp strips metadata (EXIF/ICC/etc.) by default on output - both a
// size win and a correctness one, since it's the same class of bug as
// the front-camera mirror fix: a photo that LOOKS right on the phone
// that took it but is stored sideways because only an EXIF flag said
// so, not the actual pixels.
const compressRasterImage = async (buffer, mimetype, { maxDimension, jpegQuality, webpQuality }) => {
    if (!COMPRESSIBLE_MIMETYPES.includes(mimetype)) return buffer;

    let pipeline = sharp(buffer, { failOn: "none" })
        .rotate()
        .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true });

    if (mimetype === "image/png") {
        // Lossless (compressionLevel only trades encode effort for a
        // smaller file, never touches pixel values) - safe for a logo's
        // transparency or any other PNG that must stay pixel-exact.
        pipeline = pipeline.png({ compressionLevel: 9 });
    } else if (mimetype === "image/webp") {
        pipeline = pipeline.webp({ quality: webpQuality });
    } else {
        pipeline = pipeline.jpeg({ quality: jpegQuality, mozjpeg: true });
    }

    const output = await pipeline.toBuffer();
    // Safety net: never ship something LARGER than what was uploaded -
    // can happen for an already-tiny or already-heavily-compressed image.
    return output.length < buffer.length ? output : buffer;
};

/**
 * Converts a HEIC/HEIF upload to JPEG before it ever reaches S3, then
 * (unless `options.skipCompression`) resizes/recompresses every raster
 * image to a sane storage size. Every non-image, non-HEIC file (PDF,
 * DOC/DOCX) passes through completely untouched either way.
 *
 * Returns { data, mimetype, extension } - always use these three
 * together (never the original file.data/file.mimetype/the extension
 * argument passed in) when building the S3 storage key and calling
 * putObject, so the stored bytes, the S3 Content-Type, and the file
 * extension in the key always agree with each other.
 *
 * Throws ONLY for a genuinely corrupt/undecodable HEIC/HEIF claim -
 * callers should catch this and return a 400, same as any other
 * validation failure, never a 500. A compression failure on an
 * otherwise-valid image never blocks the upload - it just falls back to
 * the uncompressed (but still HEIC-converted, if applicable) bytes.
 *
 * `options.skipCompression` exists for the one upload where resizing/
 * recompressing is a real functional risk, not just a quality
 * preference - a UPI QR code (see uploadBranchUpiQr.controller.js) must
 * stay exactly scannable, so it only ever gets the HEIC-conversion
 * pass-through, never resize/recompress.
 */
export const convertImageForStorage = async (file, resolvedExtension, options = {}) => {
    const {
        skipCompression = false,
        maxDimension = DEFAULT_MAX_DIMENSION,
        jpegQuality = DEFAULT_JPEG_QUALITY,
        webpQuality = DEFAULT_WEBP_QUALITY,
    } = options;

    let data = file.data;
    let mimetype = file.mimetype || "application/octet-stream";
    let extension = resolvedExtension;

    if (isHeic(file)) {
        data = await convert({ buffer: file.data, format: "JPEG", quality: 0.9 });
        mimetype = "image/jpeg";
        extension = "jpg";
    }

    if (!skipCompression) {
        try {
            data = await compressRasterImage(data, mimetype, { maxDimension, jpegQuality, webpQuality });
        } catch (compressionError) {
            console.error("Image compression error (falling back to uncompressed):", compressionError);
        }
    }

    return { data, mimetype, extension };
};
