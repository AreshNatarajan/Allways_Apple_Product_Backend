import express from "express";
const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import requirePermission from "../../middleware/requirePermission.js";

import { createVendorController } from "../../controllers/vendor/createVendor.controller.js";
import { getVendorController } from "../../controllers/vendor/getVendor.controller.js";
import { getAllVendorController } from "../../controllers/vendor/getAllVendor.controller.js";
import { getVendorOptionsController } from "../../controllers/vendor/searchVendor.controller.js";
import { updateVendorController } from "../../controllers/vendor/updateVendor.controller.js";
import { deleteVendorController } from "../../controllers/vendor/deleteVendor.controller.js";
import { reactivateVendorController } from "../../controllers/vendor/reactivateVendor.controller.js";
import { getVendorForTablePagination } from "../../controllers/vendor/getVendroForTablePagination.controller.js";
import { getVendorStatsController } from "../../controllers/vendor/getVendorStats.controller.js";

// Vendor is a GLOBAL master (no branchId anywhere), shared across every
// branch - one created by a branch user is usable from every branch,
// unaffected by this permission system, which only ever gates WHETHER
// a user can create/edit/deactivate a vendor, never scopes it. Reads
// are open to any authenticated role. Mutations are gated by the
// per-user permission system (requirePermission) - SUPER_ADMIN always
// passes, BRANCH_ADMIN/STAFF need the matching vendor.* grant, which
// defaults to true for both today but can be individually revoked.

// =========================
// STATIC ROUTES FIRST
// =========================

router.get("/options", authMiddleware, getVendorOptionsController);
router.get("/stats", authMiddleware, getVendorStatsController);
router.get("/pagination", authMiddleware, getVendorForTablePagination);
// New, per spec - same paginated/search/filter logic as /pagination.
// /pagination is kept mounted as-is for the existing frontend caller.
router.get("/list", authMiddleware, getVendorForTablePagination);

router.post("/create", authMiddleware, requirePermission("vendor.create"), createVendorController);
router.put("/update/:vendorId", authMiddleware, requirePermission("vendor.edit"), updateVendorController);
router.delete("/delete/:vendorId", authMiddleware, requirePermission("vendor.status"), deleteVendorController);
router.patch("/:vendorId/reactivate", authMiddleware, requirePermission("vendor.status"), reactivateVendorController);

// =========================
// DYNAMIC ROUTES LAST
// =========================

// Single vendor - kept at the existing /single/:vendorId path for
// backward compatibility, and also mounted at /:vendorId to match the
// spec and fix the existing frontend's getVendorByIdAPI, which already
// calls GET /vendor/:id directly (no route matched that before this).
router.get("/single/:vendorId", authMiddleware, getVendorController);
router.get("/:vendorId", authMiddleware, getVendorController);

// All vendors (unpaginated, dropdown-style) - global, no branch filter
router.get("/", authMiddleware, getAllVendorController);

export default router;
