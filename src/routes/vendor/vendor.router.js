import express from "express";
const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";

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
// branch. Both reads AND mutations (create/update/deactivate/
// reactivate) are open to any authenticated role - SUPER_ADMIN,
// BRANCH_ADMIN, and STAFF can all manage vendors, since any of them can
// end up needing to add/fix a vendor while creating a Purchase.

// =========================
// STATIC ROUTES FIRST
// =========================

router.get("/options", authMiddleware, getVendorOptionsController);
router.get("/stats", authMiddleware, getVendorStatsController);
router.get("/pagination", authMiddleware, getVendorForTablePagination);
// New, per spec - same paginated/search/filter logic as /pagination.
// /pagination is kept mounted as-is for the existing frontend caller.
router.get("/list", authMiddleware, getVendorForTablePagination);

router.post("/create", authMiddleware, createVendorController);
router.put("/update/:vendorId", authMiddleware, updateVendorController);
router.delete("/delete/:vendorId", authMiddleware, deleteVendorController);
router.patch("/:vendorId/reactivate", authMiddleware, reactivateVendorController);

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
