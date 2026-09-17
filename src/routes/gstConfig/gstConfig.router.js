import express from "express";

const router = express.Router();

import authMiddleware from "../../middleware/authMiddleware.js";
import onlySuperAdmin from "../../middleware/onlySuperAdmin.js";

import { getGstConfigController } from "../../controllers/gstConfig/getGstConfig.controller.js";
import { updateGstConfigController } from "../../controllers/gstConfig/updateGstConfig.controller.js";
import { uploadGstInvoiceSignatureController } from "../../controllers/gstConfig/uploadGstInvoiceSignature.controller.js";
import { getGstInvoiceSignatureImageController } from "../../controllers/gstConfig/getGstInvoiceSignatureImage.controller.js";

router.get("/", authMiddleware, getGstConfigController);
router.put("/update", authMiddleware, onlySuperAdmin, updateGstConfigController);
router.post("/upload-signature", authMiddleware, onlySuperAdmin, uploadGstInvoiceSignatureController);
// CORS-safe proxy for the raw S3 image - see getGstInvoiceSignatureImage.controller.js's own comment.
router.get("/signature-image", authMiddleware, getGstInvoiceSignatureImageController);

export default router;
