import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";

import onlySuperAdmin from "../../middleware/onlySuperAdmin.js";

import { createAdminController } from "../../controllers/users/createAdmin.controller.js";

import { updateAdminController } from "../../controllers/users/updateAdmin.controller.js"


import { createStaffController } from "../../controllers/users/creatStaff.controller.js";

import { updateStaffController } from "../../controllers/users/updateStaff.controller.js"

import { manageUserController } from "../../controllers/users/manageUser.controller.js";

import { listUsersController } from "../../controllers/users/listUsers.controller.js";

import { listLoginHistoryController } from "../../controllers/users/listLoginHistory.controller.js";

import { uploadProfileImageController } from "../../controllers/users/uploadProfileImage.controller.js";

import { getUserByIdController } from "../../controllers/users/getUserById.controller.js";

// Literal-path routes are registered before the parameterized "/:id"
// routes further down.

// User management (including View) is permanently Super Admin-only end
// to end, never delegated by the per-user permission system - see
// config/permissionCatalog.js's SUPER_ADMIN_ONLY_KEYS. Every route in
// this file stays onlySuperAdmin.
router.get(
  "/list",
  authMiddleware,
  onlySuperAdmin,
  listUsersController
);

router.get(
  "/login-history",
  authMiddleware,
  onlySuperAdmin,
  listLoginHistoryController
);

router.post(
  "/create-branch-admin",
  authMiddleware,
  onlySuperAdmin,
  createAdminController
);

router.put(
  "/update-branch-admin/:id",
  authMiddleware,
  onlySuperAdmin,
  updateAdminController
);


router.post(
  "/create-staff",
  authMiddleware,
  onlySuperAdmin,
  createStaffController
);


router.put(
  "/update-staff/:id",
  authMiddleware,
  onlySuperAdmin,
  updateStaffController
);

// Single-user read - same onlySuperAdmin as /list above. Registered
// after the literal /list and /login-history paths above so those keep
// matching first.
router.get(
  "/:id",
  authMiddleware,
  onlySuperAdmin,
  getUserByIdController
);

// Generic user management (profile edit, password reset, role change,
// branch reassignment, activate/deactivate) - SUPER_ADMIN only. Additive
// alongside the role-specific routes above, not a replacement for them.
router.put(
  "/:id",
  authMiddleware,
  onlySuperAdmin,
  manageUserController
);

router.post(
  "/:id/profile-image",
  authMiddleware,
  onlySuperAdmin,
  uploadProfileImageController
);


export default router;
