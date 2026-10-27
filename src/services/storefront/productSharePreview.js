// services/storefront/productSharePreview.js
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import sharp from "sharp";
import ProductSerial from "../../models/ProductSerial.modal.js";
import { AWS_REGION } from "../../config/s3.js";

// Link previews for shared storefront products (WhatsApp etc.). The
// storefront is a static site, so a crawler opening /product/:id only
// ever sees its generic index.html - per-product title/image has to come
// from the server. Everything here is what the public product page
// already shows; a unit the page would 404 (sold, hidden, iCloud,
// deleted) gets the generic brand preview instead.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, "../../assets/logo.png");

const WIDTH = 1200;
const HEIGHT = 630;
const BACKGROUND = "#f7f7f5";
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
// WhatsApp tends to drop thumbnails much past ~300KB.
const MAX_PREVIEW_BYTES = 280 * 1024;

/** The unit if the public product page would show it, else null. */
export const findShareableUnit = async (id) => {
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const unit = await ProductSerial.findOne({ _id: id, isDeleted: false, status: "AVAILABLE", icloud: { $ne: true }, showOnStorefront: { $ne: false } })
        .populate("productId", "name")
        .populate("currentBranchId", "name")
        .select("productId currentBranchId sellingPrice description images")
        .lean();
    return unit?.productId ? unit : null;
};

// Same order the storefront gallery uses - images[0] after sorting is
// the cover photo staff picked as position 1.
export const coverImage = (unit) => [...(unit?.images || [])].sort((a, b) => (a.position || 0) - (b.position || 0))[0] || null;

// Changes whenever the cover photo does, so a new photo gets a new
// preview URL instead of a cached old one.
export const imageVersion = (image) => crypto.createHash("sha1").update(String(image?.key || "")).digest("hex").slice(0, 10);

// Only ever fetch from our own bucket - the stored URL is never trusted
// as an arbitrary address.
const isOwnBucketUrl = (url) => {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && u.host === `${process.env.AWS_S3_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com`;
    } catch {
        return false;
    }
};

let logoBadge = null;
const getLogoBadge = async () => {
    if (logoBadge) return logoBadge;
    const size = 104;
    const logo = await sharp(LOGO_PATH).trim().resize({ width: 76, height: 76, fit: "inside" }).png().toBuffer();
    const meta = await sharp(logo).metadata();
    const card = Buffer.from(`<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="${size}" height="${size}" rx="24" fill="#ffffff"/></svg>`);
    logoBadge = await sharp(card)
        .composite([{ input: logo, top: Math.round((size - meta.height) / 2), left: Math.round((size - meta.width) / 2) }])
        .png()
        .toBuffer();
    return logoBadge;
};

// Small in-memory cache of render PROMISES - a shared link is previewed
// a few times in a row, and the share page starts the render before the
// crawler asks for the image (see productShare.controller.js), so the
// image request just waits on the job already running. A failed render
// is dropped so the next request tries again.
const cache = new Map();
const CACHE_LIMIT = 50;

/**
 * 1200x630 baseline JPEG: the unit's cover photo, letterboxed on the
 * storefront's background, with the brand logo badge in the corner.
 * Resolves to null when the photo can't be loaded (caller falls back).
 */
export const renderProductPreview = (image) => {
    if (!image?.url || !isOwnBucketUrl(image.url)) return Promise.resolve(null);
    const cacheKey = imageVersion(image);
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const job = buildPreview(image).catch(() => null).then((jpeg) => {
        if (!jpeg) cache.delete(cacheKey);
        return jpeg;
    });
    cache.set(cacheKey, job);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return job;
};

const buildPreview = async (image) => {
    const upstream = await fetch(image.url, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) return null;
    if (Number(upstream.headers.get("content-length") || 0) > MAX_SOURCE_BYTES) return null;
    const source = Buffer.from(await upstream.arrayBuffer());
    if (source.length > MAX_SOURCE_BYTES) return null;

    const photo = await sharp(source, { limitInputPixels: 60_000_000 })
        .rotate() // respect the phone's EXIF orientation
        .resize({ width: WIDTH - 80, height: HEIGHT - 60, fit: "inside", withoutEnlargement: false })
        .flatten({ background: BACKGROUND })
        .toBuffer({ resolveWithObject: true });
    const badge = await getLogoBadge();

    // composite() always runs last, so the JPEG is encoded from a
    // finished canvas in a second pass.
    const canvas = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: BACKGROUND } })
        .composite([
            { input: photo.data, top: Math.round((HEIGHT - photo.info.height) / 2), left: Math.round((WIDTH - photo.info.width) / 2) },
            { input: badge, top: HEIGHT - 104 - 24, left: 24 },
        ])
        .png()
        .toBuffer();

    // Baseline (non-progressive) JPEG - WhatsApp is unreliable with
    // progressive ones. Step quality down until it's comfortably small.
    let jpeg = null;
    for (const quality of [82, 72, 62]) {
        jpeg = await sharp(canvas).jpeg({ quality, progressive: false, mozjpeg: false, chromaSubsampling: "4:2:0" }).toBuffer();
        if (jpeg.length <= MAX_PREVIEW_BYTES) break;
    }
    return jpeg;
};
