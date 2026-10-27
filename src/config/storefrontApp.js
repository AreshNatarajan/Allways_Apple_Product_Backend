// The customer storefront (shopping-commerce). Same convention as
// config/customerApp.js: defaults to the live site, STOREFRONT_APP_URL
// overrides it (e.g. http://localhost:5180 to try a share link locally).
export const STOREFRONT_DEFAULT_URL = "https://always-apple-products-shopping.onrender.com";

export const STOREFRONT_APP_URL = (process.env.STOREFRONT_APP_URL || STOREFRONT_DEFAULT_URL).replace(/\/+$/, "");

export const buildStorefrontProductUrl = (id) => `${STOREFRONT_APP_URL}/product/${id}`;
