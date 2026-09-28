// Root of the customer-facing frontend (shopping-commerce) - NEVER the
// ERP frontend. Shared by every backend spot that builds a customer-
// facing link (setSaleInvoiceFile.controller.js's email, getSaleById's
// copy-link field, etc.) so they can never drift onto two different
// values. Falls back to the local dev port only so a missing env var
// fails obviously in dev rather than emailing/showing a broken link -
// every real deployment must set CUSTOMER_APP_URL.
export const CUSTOMER_APP_URL = process.env.CUSTOMER_APP_URL || "http://localhost:5180";

export const buildCustomerLink = (token) => (token ? `${CUSTOMER_APP_URL}/customer/${token}` : null);
