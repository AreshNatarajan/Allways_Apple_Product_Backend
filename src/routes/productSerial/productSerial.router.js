import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import { requireAnyPermission } from '../../middleware/requirePermission.js';

import { uploadProductSerialStagingImagesController } from '../../controllers/productSerial/uploadProductSerialStagingImage.controller.js';
import { deleteProductSerialStagingImageController } from '../../controllers/productSerial/deleteProductSerialStagingImage.controller.js';

// Staging upload/delete for a serialized unit's description/images
// while a purchase is still being composed - the ProductSerial document
// itself doesn't exist yet at this point (see uploadProductSerialStagingImage
// .controller.js for why). Gated the same as purchase creation itself
// (requirePermission('purchase.create'), not the old hardcoded
// onlyAdminRoles) since this is part of that same flow - a STAFF user
// granted purchase.create could create the purchase but was still
// blocked from uploading its serial images, since this route was never
// migrated when purchase.create became a per-user grant.
// purchase.edit too: the Edit Purchase screen and the transferred-units
// editor (a branch updating photos of units transferred to it) upload
// through the same staging endpoint.
const SERIAL_IMAGE_PERMISSIONS = ['purchase.create', 'purchase.edit'];
router.post('/staging-images', authMiddleware, requireAnyPermission(SERIAL_IMAGE_PERMISSIONS), uploadProductSerialStagingImagesController);
router.delete('/staging-images', authMiddleware, requireAnyPermission(SERIAL_IMAGE_PERMISSIONS), deleteProductSerialStagingImageController);

export default router;
