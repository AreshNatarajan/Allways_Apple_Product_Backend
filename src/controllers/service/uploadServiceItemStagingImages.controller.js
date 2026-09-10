// controllers/service/uploadServiceItemStagingImages.controller.js
import crypto from "crypto";
import {
  validateImageFile,
  resolveImageExtension,
} from "../../middleware/uploadUserImage.middleware.js";
import { convertImageForStorage } from "../../services/image/convertImageForStorage.js";
import { putObject } from "../fileUpload/Products/putObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Mirrors uploadProductSerialStagingImage.controller.js exactly, for a
// customer-owned Service item's condition photos. Uploaded BEFORE the
// Service document exists - a service ticket is composed client-side
// row by row, so these are real S3 objects the moment they're picked,
// carried as {url,key,name} in the item payload at submit time (see
// createService.controller.js).
export const uploadServiceItemStagingImagesController = async (req, res) => {
  try {
    const rawFiles = req.files?.images;

    if (!rawFiles) {
      return errorResponse(res, "No image file(s) uploaded", 400);
    }

    const files = Array.isArray(rawFiles) ? rawFiles : [rawFiles];

    for (const file of files) {
      const validationError = validateImageFile(file);
      if (validationError) {
        return errorResponse(res, validationError, 400);
      }
    }

    let converted;
    try {
      converted = await Promise.all(files.map((file) => convertImageForStorage(file, resolveImageExtension(file))));
    } catch (conversionError) {
      console.error("HEIC conversion error:", conversionError);
      return errorResponse(res, "Could not process one of these images - the file may be corrupted", 400);
    }

    const uploaded = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const { data, mimetype, extension } = converted[i];
      const storageKey = `services/staging/${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${extension}`;

      const { url, key } = await putObject(data, storageKey, mimetype);
      uploaded.push({ url, key, name: file.name || "" });
    }

    return successResponse(res, "Image(s) uploaded successfully", { images: uploaded }, 201);
  } catch (error) {
    console.error("Upload Service Item Staging Image Error:", error);
    return errorResponse(res, "Server error while uploading image(s)", 500);
  }
};
