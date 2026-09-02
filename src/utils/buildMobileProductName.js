// Single source of truth for the MOBILE structured product name format -
// mirrored on the frontend (src/pages/product/utils/buildMobileProductName.js)
// for a live preview, but this backend copy is the one that's actually
// authoritative (createProduct/updateProduct.controller.js always
// regenerate `name` from this, never trust a client-sent string).
//
// Format: "{PRODUCT NAME} {NUMBER} {SERIES} {MODEL NUMBER}" - SERIES is
// omitted entirely when it's BASIC (the base line has no series word in
// its name at all, never literally "BASIC").
//   buildMobileProductName({ productName: "IPHONE", number: "16", series: "PRO", modelNumber: "A2442" })
//     -> 'IPHONE 16 PRO A2442'
//   buildMobileProductName({ productName: "IPHONE", number: "16", series: "BASIC", modelNumber: "A2442" })
//     -> 'IPHONE 16 A2442'
//
// Every text part is trimmed, internal whitespace collapsed to a single
// space, and the whole result uppercased - same determinism rule as
// buildLaptopProductName.js, so two admins entering the "same" phone can
// never end up with two differently-formatted (and therefore
// accidentally duplicate) Product records.
const cleanPart = (value) => String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();

export const buildMobileProductName = ({ productName, number, series, modelNumber }) => {
    const seriesLabel = cleanPart(series) === "BASIC" ? "" : cleanPart(series);
    return [cleanPart(productName), cleanPart(number), seriesLabel, cleanPart(modelNumber)]
        .filter(Boolean)
        .join(" ");
};

// Shared validation so createProduct/updateProduct.controller.js reject
// an incomplete structure with the exact same message/rules.
export const validateMobileNameParts = ({ productName, number, series, modelNumber }) => {
    if (!productName || !String(productName).trim()) return "Product Name is required";
    if (!number || !String(number).trim()) return "Number is required";
    if (!series || !String(series).trim()) return "Series is required";
    if (!modelNumber || !String(modelNumber).trim()) return "Model Number is required";
    return null;
};
