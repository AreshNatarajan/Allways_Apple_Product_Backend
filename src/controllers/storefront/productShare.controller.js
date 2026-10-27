// controllers/storefront/productShare.controller.js
import { STOREFRONT_APP_URL, buildStorefrontProductUrl } from "../../config/storefrontApp.js";
import { findShareableUnit, coverImage, imageVersion, renderProductPreview } from "../../services/storefront/productSharePreview.js";

// PUBLIC - the link the storefront's Share button sends: /p/:id.
// Crawlers (WhatsApp, Facebook...) read this page's tags for the preview;
// people are sent straight on to the real product page. Only data the
// public product page already shows ever appears here.

const BRAND = "Always Apple Products";
const GENERIC_DESCRIPTION = "Pre-owned Apple hardware - iPhone, MacBook, iPad and more - inspected unit by unit at our showrooms.";

const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Mirrors shopping-commerce's formatPrice / formatBranchName.
const formatPrice = (n) => `₹${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const formatBranchName = (name) => (name || "").replace(/^AAP[_\s-]*/i, "").trim() || name || "";

const clip = (s, max) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

// The public origin serving /p/* - set PRODUCT_SHARE_BASE_URL when the
// links go out under another domain (e.g. a storefront rewrite);
// otherwise whatever host this request came in on.
const shareBase = (req) => (process.env.PRODUCT_SHARE_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

const renderPage = ({ title, description, image, imageType, pageUrl, target }) => {
    const t = escapeHtml(title);
    const d = escapeHtml(description);
    const img = escapeHtml(image);
    const go = escapeHtml(target);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${t}</title>
<meta name="description" content="${d}" />
<meta property="og:type" content="product" />
<meta property="og:site_name" content="${BRAND}" />
<meta property="og:title" content="${t}" />
<meta property="og:description" content="${d}" />
<meta property="og:url" content="${escapeHtml(pageUrl)}" />
<meta property="og:image" content="${img}" />
<meta property="og:image:secure_url" content="${img}" />
<meta property="og:image:type" content="${imageType}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${t}" />
<meta property="og:locale" content="en_IN" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${t}" />
<meta name="twitter:description" content="${d}" />
<meta name="twitter:image" content="${img}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="0;url=${go}" />
<link rel="canonical" href="${go}" />
</head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:#1d1d1f">
<p>Opening <a href="${go}">${t}</a>…</p>
<script>location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")});</script>
</body>
</html>`;
};

export const productSharePageController = async (req, res) => {
    const { id } = req.params;
    const target = buildStorefrontProductUrl(encodeURIComponent(id));
    const pageUrl = `${shareBase(req)}/p/${encodeURIComponent(id)}`;
    const generic = {
        title: `Shop pre-owned Apple | ${BRAND}`,
        description: GENERIC_DESCRIPTION,
        image: `${STOREFRONT_APP_URL}/og-preview.png`,
        imageType: "image/png",
        pageUrl,
        target,
    };
    let page = generic;
    try {
        const unit = await findShareableUnit(id);
        if (unit) {
            const cover = coverImage(unit);
            // Start the image now: the crawler asks for it right after
            // this page, and a cold render can take several seconds.
            if (cover) renderProductPreview(cover);
            const showroom = formatBranchName(unit.currentBranchId?.name);
            page = {
                ...generic,
                title: `${unit.productId.name} | ${BRAND}`,
                description: [formatPrice(unit.sellingPrice), clip(unit.description?.main, 110), showroom && `At our ${showroom} showroom`].filter(Boolean).join(" · "),
                // No photo yet -> the brand image, still with the product's own title.
                ...(cover ? { image: `${shareBase(req)}/p/${encodeURIComponent(id)}/preview-${imageVersion(cover)}.jpg`, imageType: "image/jpeg" } : {}),
            };
        }
    } catch (error) {
        console.error("Product Share Page Error:", error?.message);
    }
    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Cache-Control", "public, max-age=300");
    return res.status(200).send(renderPage(page));
};

// The preview image itself. Any trouble (sold, no photo, fetch failed)
// sends the crawler to the generic brand image rather than an error.
export const productSharePreviewImageController = async (req, res) => {
    const fallback = () => res.redirect(302, `${STOREFRONT_APP_URL}/og-preview.png`);
    try {
        const unit = await findShareableUnit(req.params.id);
        const cover = coverImage(unit);
        if (!cover) return fallback();
        const jpeg = await renderProductPreview(cover);
        if (!jpeg) return fallback();
        res.set("Content-Type", "image/jpeg");
        // no-transform: stops the CDN re-compressing it into a
        // progressive JPEG. The URL changes with the photo, so a long
        // cache is safe.
        res.set("Cache-Control", "public, max-age=86400, no-transform");
        return res.send(jpeg);
    } catch (error) {
        console.error("Product Share Image Error:", error?.message);
        return fallback();
    }
};
