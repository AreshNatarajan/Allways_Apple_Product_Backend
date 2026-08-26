import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import requirePermission from "../../middleware/requirePermission.js";

import { createCustomerController } from "../../controllers/customer/createCustomer.controller.js";
import { getAllCustomersController } from "../../controllers/customer/getAllCustomer.controller.js";
import { searchCustomerController } from "../../controllers/customer/searchCustomer.controller.js";
import { getCustomerController } from "../../controllers/customer/getCustomer.controller.js";
import { deleteCustomerController } from "../../controllers/customer/deleteCustomer.controller.js";
import { reactivateCustomerController } from "../../controllers/customer/reactivateCustomer.controller.js";
import { updateCustomerController } from "../../controllers/customer/updateCustomer.Controller.js";
import { getCustomerStatsController } from "../../controllers/customer/getCustomerStats.controller.js";
import { getCustomerForTablePagination } from "../../controllers/customer/getCustomerForTablePagination.controller.js";

// Customer is BRANCH-SCOPED (unlike Vendor, which is a global master).
// Reads are open to any authenticated role. Writes are gated by the
// per-user permission system (requirePermission - see
// config/permissionCatalog.js) rather than a fixed role check -
// SUPER_ADMIN always passes, BRANCH_ADMIN/STAFF need the matching
// customer.* grant, which defaults to true for both today (realistic
// need for STAFF to add/edit walk-in customers during a sale) but can
// be individually revoked per user. Branch isolation itself is
// enforced inside each controller via getCustomerBranchFilter,
// independent of this permission check.

// =========================
// STATIC ROUTES FIRST
// =========================

router.get(
  "/options",
  authMiddleware,
  searchCustomerController
);

router.get(
  "/stats",
  authMiddleware,
  getCustomerStatsController
);

router.get(
  "/pagination",
  authMiddleware,
  getCustomerForTablePagination
);

// New, per spec - same paginated/search/filter logic as /pagination.
// /pagination is kept mounted as-is for the existing frontend caller.
router.get(
  "/list",
  authMiddleware,
  getCustomerForTablePagination
);


// =========================
// ACTION ROUTES
// =========================

router.post(
  "/create",
  authMiddleware,
  requirePermission("customer.create"),
  createCustomerController
);

router.put(
  "/update/:customerId",
  authMiddleware,
  requirePermission("customer.edit"),
  updateCustomerController
);

router.delete(
  "/delete/:customerId",
  authMiddleware,
  requirePermission("customer.status"),
  deleteCustomerController
);

router.patch(
  "/:customerId/reactivate",
  authMiddleware,
  requirePermission("customer.status"),
  reactivateCustomerController
);


// =========================
// DYNAMIC ROUTES LAST
// =========================

// Single Customer - kept at the existing /single/:customerId path for
// backward compatibility, and also mounted at /:customerId to match
// the spec (GET /customer/:id) and the frontend's existing
// getCustomerByIdAPI, which already calls GET /customer/:id directly.
router.get(
  "/single/:customerId",
  authMiddleware,
  getCustomerController
);

router.get(
  "/:customerId",
  authMiddleware,
  getCustomerController
);

// All customers (unpaginated, dropdown-style, branch-scoped via query
// ?branchId=) - mirrors Vendor's root dropdown route. Mounted last
// since it's a static "/" path with no conflicting dynamic segment.
router.get(
  "/",
  authMiddleware,
  getAllCustomersController
);

export default router;
