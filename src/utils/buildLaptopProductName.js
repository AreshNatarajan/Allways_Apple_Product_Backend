// Single source of truth for the LAPTOP structured product name format -
// mirrored on the frontend (src/pages/product/utils/buildLaptopProductName.js)
// for a live preview, but this backend copy is the one that's actually
// authoritative (createProduct/updateProduct.controller.js always
// regenerate `name` from this, never trust a client-sent string).
//
// Format: "{PRODUCT NAME} {SERIES} {size1}/{size2}\"-{MODEL NUMBER}" - the
// inch mark appears exactly once, after the LAST size, never after each one.
//   buildLaptopProductName({ productName: "MACBOOK", series: "AIR", screenSizes: [13], modelNumber: "A1466" })
//     -> 'MACBOOK AIR 13"-A1466'
//   buildLaptopProductName({ productName: "MACBOOK", series: "AIR", screenSizes: [13, 17], modelNumber: "A1466" })
//     -> 'MACBOOK AIR 13/17"-A1466'
//
// Every text part is trimmed, internal whitespace collapsed to a single
// space, and the whole result uppercased - this is what makes the format
// deterministic: two admins entering the "same" laptop can never end up
// with two differently-formatted (and therefore accidentally duplicate)
// Product records, which is the exact bug this feature exists to prevent.
const cleanPart = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();

export const buildLaptopProductName = ({ productName, series, screenSizes, modelNumber }) => {
    const sizes = [...new Set((screenSizes || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))]
        .sort((a, b) => a - b);
    const sizesLabel = sizes.length > 0 ? `${sizes.join("/")}"` : "";
    return `${cleanPart(productName)} ${cleanPart(series)} ${sizesLabel}-${cleanPart(modelNumber)}`;
};

// Shared validation so createProduct/updateProduct.controller.js reject
// an incomplete structure with the exact same message/rules.
export const validateLaptopNameParts = ({ productName, series, screenSizes, modelNumber }) => {
    if (!productName || !String(productName).trim()) return "Product Name is required";
    if (!series || !String(series).trim()) return "Series is required";
    if (!modelNumber || !String(modelNumber).trim()) return "Model Number is required";
    const sizes = (screenSizes || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
    if (sizes.length === 0) return "At least one screen size is required";
    return null;
};
