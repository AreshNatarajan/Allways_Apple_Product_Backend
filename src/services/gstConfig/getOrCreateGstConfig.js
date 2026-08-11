// services/gstConfig/getOrCreateGstConfig.js
import GstConfig from "../../models/GstConfig.model.js";

// Single-document settings pattern - there is never more than one
// GstConfig document. Finds it, or creates one with pure schema
// defaults on first-ever read (never a destructive migration, never
// rewrites an existing document). Accepts an optional Mongoose
// session so callers already inside a transaction (createSale) can
// keep this read/create atomic with the rest of their work.
export const getOrCreateGstConfig = async ({ session } = {}) => {
    let config = await GstConfig.findOne().session(session || null);

    if (!config) {
        const created = await GstConfig.create([{}], { session });
        config = created[0];
    }

    return config;
};
