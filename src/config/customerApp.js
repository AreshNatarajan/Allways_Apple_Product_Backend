// Root of the customer invoice app (shopping-invoice) - NEVER the ERP
// frontend, and no longer the shopping-commerce storefront. Shared by
// every backend spot that builds a customer-facing link (getSaleById's
// copy-link field, setSaleInvoiceFile.controller.js's email, etc.) so
// they can never drift onto two different values. Defaults to the live
// invoice site, so copied links open on a customer's phone (and show as
// tappable links in WhatsApp) even from a local backend. Set
// INVOICE_APP_URL to override it - e.g. http://localhost:5190 to try the
// invoice app locally (server.js also adds it to the CORS allowlist).
export const INVOICE_APP_DEFAULT_URL = "https://shopping-invoice.onrender.com";

export const CUSTOMER_APP_URL = (process.env.INVOICE_APP_URL || INVOICE_APP_DEFAULT_URL).replace(/\/+$/, "");

export const buildCustomerLink = (token) => (token ? `${CUSTOMER_APP_URL}/invoice/${token}` : null);
