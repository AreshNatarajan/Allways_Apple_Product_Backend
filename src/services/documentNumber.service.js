// services/documentNumber.service.js
import mongoose from "mongoose";

// Shared atomic counter, one document per (docType, year-month) key -
// e.g. "purchase:202608", "sale:202608", "transfer:202608". This is
// the same atomic findOneAndUpdate($inc) pattern the Purchase module
// already used safely (its own inline PurchaseCounter model, now
// generalized here for all three document types) - Sale and Transfer
// previously used non-atomic count/sort-then-increment logic that
// could race under concurrent requests; this closes that gap.
const documentCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // "<docType>:<YYYYMM>"
  seq: { type: Number, default: 0 },
});
const DocumentCounter = mongoose.model("DocumentCounter", documentCounterSchema);

const monthKey = (date) => `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;

/**
 * Atomically reserves the next sequence number for `docType` (e.g.
 * "purchase", "sale", "transfer") within the current year-month, and
 * formats it as `${prefix}-${YYYYMM}-${seq}`. Prefix is whatever the
 * caller passes in - always read fresh from GstConfig by the caller,
 * never hardcoded here, so a prefix change takes effect on the very
 * next document without touching anything already generated.
 */
export const generateDocumentNumber = async (docType, prefix, { session } = {}) => {
  const key = monthKey(new Date());
  const counter = await DocumentCounter.findOneAndUpdate(
    { _id: `${docType}:${key}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session, returnDocument: "after" }
  );
  const sequence = String(counter.seq).padStart(4, "0");
  return `${prefix}-${key}-${sequence}`;
};
