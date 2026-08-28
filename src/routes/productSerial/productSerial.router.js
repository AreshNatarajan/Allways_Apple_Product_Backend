import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import requirePermission from '../../middleware/requirePermission.js';

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
router.post('/staging-images', authMiddleware, requirePermission('purchase.create'), uploadProductSerialStagingImagesController);
router.delete('/staging-images', authMiddleware, requirePermission('purchase.create'), deleteProductSerialStagingImageController);

export default router;
