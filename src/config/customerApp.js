// Root of the customer invoice app (shopping-invoice) - NEVER the ERP
// frontend, and no longer the shopping-commerce storefront. Shared by
// every backend spot that builds a customer-facing link (getSaleById's
// copy-link field, setSaleInvoiceFile.controller.js's email, etc.) so
// they can never drift onto two different values. Falls back to the
// local dev port only so a missing env var fails obviously in dev rather
// than showing a broken link - every real deployment must set
// INVOICE_APP_URL (server.js also adds it to the CORS allowlist).
export const CUSTOMER_APP_URL = (process.env.INVOICE_APP_URL || "http://localhost:5190").replace(/\/+$/, "");

export const buildCustomerLink = (token) => (token ? `${CUSTOMER_APP_URL}/invoice/${token}` : null);
