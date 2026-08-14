// Product type (serialized vs non-serialized) is no longer a client
// choice - it's derived server-side from category, so a stale/tampered
// payload can never disagree with the product's actual category.
export const CATEGORY_SERIALIZED_MAP = {
    ACCESSORY: false,
    MOBILE: true,
    LAPTOP: true,
    TAB: true,
};

export const deriveIsSerialized = (category) => CATEGORY_SERIALIZED_MAP[category] ?? false;
