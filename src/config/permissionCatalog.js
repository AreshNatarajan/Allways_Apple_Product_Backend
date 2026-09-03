// Backend mirror of shopping-frontend/src/pages/user/userPermissionsCatalog.js -
// same keys, same superAdminOnly set, same per-role defaults, ported
// verbatim so the two never drift apart. This file is the source of
// truth for what a saved User.permissions object is allowed to
// contain (see manageUser.controller.js) and what requirePermission.js
// checks against.
//
// Five keys are superAdminOnly - purchase.review/sale.review (EOD
// review), branch.view/user.view (Branch and User management are
// permanently Super Admin-only end to end, viewing included - not just
// their write operations), and report.profitLoss.view (the one report
// that exposes cost/margin figures). manageUserController forces any
// superAdminOnly key back to false on every save, regardless of what
// was sent. Note this is unrelated to GET /branch/list (the plain
// dropdown used app-wide by Transfer/User/etc. branch selectors) or a
// branch user's own-branch detail view - those aren't gated by this
// permission system at all, see branch.router.js.

export const PERMISSION_KEYS = [
  "product.create", "product.edit", "product.status",
  "customer.create", "customer.edit", "customer.status",
  "vendor.create", "vendor.edit", "vendor.status",
  "noteTemplate.create", "noteTemplate.delete",
  "branch.view",
  "user.view",
  "purchase.create", "purchase.edit", "purchase.review",
  "sale.create", "sale.edit", "sale.review", "sale.return", "sale.exchange", "sale.tradeIn",
  "transfer.create", "transfer.dispatch", "transfer.cancel", "transfer.receive",
  "pendingReceive.receive",
  "report.profitLoss.view",
];

export const SUPER_ADMIN_ONLY_KEYS = ["purchase.review", "sale.review", "branch.view", "user.view", "report.profitLoss.view"];

// What each role can ALREADY do today, absent any explicit grant -
// used only to seed the one-time migration script for pre-existing
// users. Going forward, a brand-new user's `permissions` starts as
// this same default too (see createAdmin.controller.js/creatStaff.controller.js),
// so nothing ever silently regresses to zero access.
export const DEFAULT_PERMISSIONS_BY_ROLE = {
  BRANCH_ADMIN: [
    "product.create", "product.edit", "product.status",
    "customer.create", "customer.edit", "customer.status",
    "vendor.create", "vendor.edit", "vendor.status",
    "noteTemplate.create", "noteTemplate.delete",
    "purchase.create", "purchase.edit",
    "sale.create", "sale.edit", "sale.return", "sale.exchange", "sale.tradeIn",
    "transfer.create", "transfer.dispatch", "transfer.cancel", "transfer.receive",
    "pendingReceive.receive",
  ],
  STAFF: [
    "customer.create", "customer.edit", "customer.status",
    "vendor.create", "vendor.edit", "vendor.status",
    "noteTemplate.create", "noteTemplate.delete",
    "purchase.create", "purchase.edit",
    "sale.create", "sale.edit", "sale.return", "sale.exchange", "sale.tradeIn",
    "transfer.create", "transfer.dispatch", "transfer.cancel", "transfer.receive",
    "pendingReceive.receive",
  ],
};

export const defaultPermissionsForRole = (role) => {
  const granted = new Set(DEFAULT_PERMISSIONS_BY_ROLE[role] || []);
  const state = {};
  for (const key of PERMISSION_KEYS) {
    state[key] = SUPER_ADMIN_ONLY_KEYS.includes(key) ? false : granted.has(key);
  }
  return state;
};

// Strips out any key not in PERMISSION_KEYS and force-falses any
// SUPER_ADMIN_ONLY_KEYS entry, regardless of what the caller sent.
// Used by manageUser.controller.js before persisting a permissions
// object, so a malformed/tampered payload can never widen access
// beyond what this catalog actually defines.
export const sanitizePermissions = (input) => {
  const sanitized = {};
  if (!input || typeof input !== "object") return sanitized;
  for (const key of PERMISSION_KEYS) {
    if (SUPER_ADMIN_ONLY_KEYS.includes(key)) {
      sanitized[key] = false;
    } else if (key in input) {
      sanitized[key] = input[key] === true;
    }
  }
  return sanitized;
};
