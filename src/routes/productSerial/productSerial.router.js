import express from 'express';
const router = express.Router();

import authMiddleware from '../../middleware/authMiddleware.js';
import onlyAdminRoles from '../../middleware/onlyAdminRoles.js';

import { uploadProductSerialStagingImagesController } from '../../controllers/productSerial/uploadProductSerialStagingImage.controller.js';
import { deleteProductSerialStagingImageController } from '../../controllers/productSerial/deleteProductSerialStagingImage.controller.js';

// Staging upload/delete for a serialized unit's description/images
// while a purchase is still being composed - the ProductSerial document
// itself doesn't exist yet at this point (see uploadProductSerialStagingImage
// .controller.js for why). Same role gate as Product's own image
// endpoints (SUPER_ADMIN / BRANCH_ADMIN - matches who can create a
// purchase in the first place).
router.post('/staging-images', authMiddleware, onlyAdminRoles, uploadProductSerialStagingImagesController);
router.delete('/staging-images', authMiddleware, onlyAdminRoles, deleteProductSerialStagingImageController);

export default router;
