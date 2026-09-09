// controllers/service/deleteServiceItemStagingImage.controller.js
import { deleteObject } from "../fileUpload/Products/deleteObject.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Mirrors deleteProductSerialStagingImage.controller.js. Removes a
// staged Service item image while a ticket is still being composed
// client-side, before any Service document exists to own it.
export const deleteServiceItemStagingImageController = async (req, res) => {
  try {
    const { key } = req.body;

    if (!key) {
      return errorResponse(res, "Image key is required", 400);
    }
    if (!key.startsWith("services/staging/")) {
      return errorResponse(res, "Invalid staging image key", 400);
    }

    await deleteObject(key);

    return successResponse(res, "Staged image removed successfully", { key });
  } catch (error) {
    console.error("Delete Service Item Staging Image Error:", error);
    return errorResponse(res, "Server error while removing staged image", 500);
  }
};
