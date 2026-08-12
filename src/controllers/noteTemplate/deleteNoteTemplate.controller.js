// controllers/noteTemplate/deleteNoteTemplate.controller.js
import mongoose from "mongoose";
import NoteTemplate from "../../models/NoteTemplate.model.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// Soft delete only, matching this project's convention - any
// authenticated user can remove any template (same "usable by anyone
// who can see it" behavior the old localStorage chips already had, just
// now shared across the app instead of one browser).
export const deleteNoteTemplateController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid template ID", 400);
        }

        const template = await NoteTemplate.findOneAndUpdate(
            { _id: id, isDeleted: false },
            { isDeleted: true },
            { new: true }
        );

        if (!template) {
            return errorResponse(res, "Note template not found", 404);
        }

        return successResponse(res, "Note template removed successfully", { _id: template._id });
    } catch (error) {
        console.error("Delete Note Template Error:", error);
        return errorResponse(res, "Server error while removing note template", 500);
    }
};
