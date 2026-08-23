// Inventory cost data (purchase price, purchase GST, purchase amount,
// profit) is SUPER_ADMIN-only everywhere in Inventory - list, dashboard,
// and both detail pages. Not a generic "hide field X" abstraction since
// every call site strips a different concrete field set - this is just
// the one shared role check they all gate on.
export const canViewInventoryCost = (role) => role === "SUPER_ADMIN";
