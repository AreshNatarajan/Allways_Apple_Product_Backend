// controllers/noteTemplate/getNoteTemplates.controller.js
import NoteTemplate from "../../models/NoteTemplate.model.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const VALID_TYPES = ["PURCHASE", "SALE"];

export const getNoteTemplatesController = async (req, res) => {
    try {
        const { type } = req.query;

        if (!VALID_TYPES.includes(type)) {
            return errorResponse(res, "type query param must be PURCHASE or SALE", 400);
        }

        const templates = await NoteTemplate.find({ type, isDeleted: false })
            .sort({ createdAt: 1 })
            .lean();

        return successResponse(res, "Note templates retrieved successfully", templates);
    } catch (error) {
        console.error("Get Note Templates Error:", error);
        return errorResponse(res, "Server error while retrieving note templates", 500);
    }
};
