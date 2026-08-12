// models/NoteTemplate.model.js
import mongoose from "mongoose";

// Reusable "quick insert" note snippets shown as chips on the Purchase/
// Sale Notes field (e.g. "1 month warranty") - previously stored in the
// browser's own localStorage (per-device, invisible to other staff/
// devices, lost if browser data is cleared). This is the real,
// database-backed replacement: shared across the whole app for a given
// `type`, not scoped per-user, matching how the old localStorage chips
// were already usable by anyone on that browser.
const noteTemplateSchema = new mongoose.Schema(
    {
        // Which screen this template's chip shows up on - Purchase and
        // Sale keep separate template libraries (a supplier-facing
        // Purchase warranty note isn't necessarily relevant to a
        // customer-facing Sale note), same separation the old
        // per-screen localStorage keys already had.
        type: {
            type: String,
            enum: ["PURCHASE", "SALE"],
            required: true,
        },

        label: {
            type: String,
            required: true,
            trim: true,
        },

        text: {
            type: String,
            required: true,
            trim: true,
        },

        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        isDeleted: {
            type: Boolean,
            default: false,
        },
    },
    { timestamps: true }
);

noteTemplateSchema.index({ type: 1, isDeleted: 1 });

const NoteTemplate = mongoose.model("NoteTemplate", noteTemplateSchema);

export default NoteTemplate;
