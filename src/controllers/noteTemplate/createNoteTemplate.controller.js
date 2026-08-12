// controllers/noteTemplate/createNoteTemplate.controller.js
import NoteTemplate from "../../models/NoteTemplate.model.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const VALID_TYPES = ["PURCHASE", "SALE"];

export const createNoteTemplateController = async (req, res) => {
    try {
        const { type, label, text } = req.body;

        if (!VALID_TYPES.includes(type)) {
            return errorResponse(res, "type must be PURCHASE or SALE", 400);
        }
        if (!label || !label.trim()) {
            return errorResponse(res, "Label is required", 400);
        }
        if (!text || !text.trim()) {
            return errorResponse(res, "Text is required", 400);
        }

        const template = await NoteTemplate.create({
            type,
            label: label.trim().slice(0, 60),
            text: text.trim().slice(0, 1000),
            createdBy: req.user._id,
        });

        return successResponse(res, "Note template created successfully", template, 201);
    } catch (error) {
        console.error("Create Note Template Error:", error);
        return errorResponse(res, "Server error while creating note template", 500);
    }
};
