// services/storefront/branchMap.js
//
// Turns the Google Maps link staff paste into a branch's googleMapUrl (ERP
// Branch form) into something the storefront can EMBED in an <iframe>.
//
// Google blocks its normal pages / share links inside iframes, so:
//   1. Short share links (maps.app.goo.gl/...) are followed once to the full
//      maps URL (redirects only - nothing else is requested).
//   2. The exact pin is read from that URL: "!3d<lat>!4d<lng>" (the place's
//      own pin) first, then "@<lat>,<lng>", then a "q=<lat>,<lng>" query.
//   3. That becomes Google's keyless embed page for "<lat>,<lng>"
//      (embeddable, no API key). A link with only a place name falls back to
//      a search for that name, and a branch with no link to its address.
// An "Embed a map" iframe code / embed URL pasted as-is is used directly.
// Results are cached in memory so each link is resolved at most once a day.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // key -> { value, at }

// Only Google's own map / short-link hosts are ever fetched.
const ALLOWED_HOSTS = [/^maps\.app\.goo\.gl$/i, /^goo\.gl$/i, /^g\.co$/i, /^(www\.|maps\.)?google\.[a-z.]+$/i];
const isAllowedHost = (url) => {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
    } catch {
        return false;
    }
};

// The keyless embed page Google itself redirects maps.google.com/maps?q=..&output=embed
// to - linked directly so the iframe never passes through that redirect
// (which is marked same-origin only). "!" separates pb fields, so it is escaped.
const embedForQuery = (q) =>
    `https://www.google.com/maps/embed?origin=mfe&pb=!1m3!2m1!1s${encodeURIComponent(q).replace(/%20/g, "+").replace(/!/g, "%21")}!6i17`;
const validCoords = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** Pulls an iframe's src out of pasted embed code, or returns the text trimmed. */
const extractUrl = (raw) => {
    const text = String(raw || "").trim();
    const src = text.match(/src\s*=\s*["']([^"']+)["']/i);
    return (src ? src[1] : text).replace(/&amp;/g, "&");
};

/** Exact coordinates / place name from a full Google Maps URL. */
export const parseMapsUrl = (url) => {
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch { /* keep as-is */ }
    const pin = decoded.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (pin && validCoords(+pin[1], +pin[2])) return { lat: +pin[1], lng: +pin[2] };
    const at = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (at && validCoords(+at[1], +at[2])) return { lat: +at[1], lng: +at[2] };
    let params;
    try { params = new URL(url).searchParams; } catch { params = new URLSearchParams(); }
    for (const key of ["q", "query", "ll", "center", "destination"]) {
        const v = params.get(key);
        if (!v) continue;
        const ll = v.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
        if (ll && validCoords(+ll[1], +ll[2])) return { lat: +ll[1], lng: +ll[2] };
        if (key === "q" || key === "query") return { place: v };
    }
    const place = decoded.match(/\/maps\/place\/([^/@?]+)/);
    if (place) return { place: place[1].replace(/\+/g, " ") };
    return null;
};

/** Follows a short link's redirects (max 5) to the final Google Maps URL. */
const resolveRedirects = async (url) => {
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
        if (!isAllowedHost(current)) return current;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(current, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "User-Agent": "Mozilla/5.0" } });
            const location = res.headers.get("location");
            if (res.status >= 300 && res.status < 400 && location) {
                const next = new URL(location, current).toString();
                // Consent interstitials carry the real target in ?continue=
                const cont = new URL(next).searchParams.get("continue");
                current = cont && isAllowedHost(cont) ? cont : next;
                continue;
            }
            return current;
        } finally {
            clearTimeout(timer);
        }
    }
    return current;
};

/**
 * { mapUrl, mapEmbedUrl } for one branch. mapUrl is the link staff entered
 * (opens Google Maps in a new tab); mapEmbedUrl is iframe-safe, or null when
 * there's nothing to show.
 */
export const getBranchMap = async (branch) => {
    const raw = extractUrl(branch?.googleMapUrl);
    const address = [branch?.address?.addressLine1, branch?.address?.addressLine2, branch?.address?.city, branch?.address?.state, branch?.address?.pincode]
        .filter((p) => p && String(p).trim()).join(", ");
    const mapUrl = raw && isAllowedHost(raw) && !raw.includes("/maps/embed") ? raw : null;

    const key = `${raw}|${address}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    let mapEmbedUrl = null;
    if (raw && isAllowedHost(raw)) {
        if (/\/maps\/embed/.test(raw) || /[?&]output=embed/.test(raw)) {
            mapEmbedUrl = raw;
        } else {
            try {
                const full = await resolveRedirects(raw);
                const found = parseMapsUrl(full) || parseMapsUrl(raw);
                if (found?.lat !== undefined) mapEmbedUrl = embedForQuery(`${found.lat},${found.lng}`);
                else if (found?.place) mapEmbedUrl = embedForQuery(found.place);
            } catch (error) {
                console.error("Branch map link could not be resolved:", raw, error?.message || error);
            }
        }
    }
    if (!mapEmbedUrl && address) mapEmbedUrl = embedForQuery(address);

    // Address as a last-resort "open in maps" link too.
    const value = { mapUrl: mapUrl || (address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : null), mapEmbedUrl };
    cache.set(key, { value, at: Date.now() });
    return value;
};

/** The public, customer-safe view of a branch: no bank/UPI/GST details. */
export const toPublicShowroom = async (branch) => {
    if (!branch) return null;
    const { mapUrl, mapEmbedUrl } = await getBranchMap(branch);
    const a = branch.address || {};
    return {
        _id: branch._id,
        name: branch.name,
        code: branch.code || "",
        phone: (branch.phones || []).find((p) => p && String(p).trim()) || "",
        address: [a.addressLine1, a.addressLine2, a.city, a.state, a.pincode].filter((p) => p && String(p).trim()).join(", "),
        mapUrl,
        mapEmbedUrl,
    };
};

export const PUBLIC_SHOWROOM_FIELDS = "name code phones address googleMapUrl";
