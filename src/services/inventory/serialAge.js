// services/inventory/serialAge.js
//
// A serialized unit's inventory Age counts from its purchase date - but a
// unit a customer brought back (Sale Return, or the old unit of a Sale
// Exchange) is treated as fresh stock: its Age restarts from the day it
// came back. The return date is read from the append-only StockMovement
// ledger (type RETURN, written by createSaleReturn/createSaleExchange), so
// it needs no extra field on ProductSerial and covers past returns too.
import StockMovement from "../../models/StockMovement.model.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// serialIds -> Map(serialId string -> latest customer-return Date)
export const getLastReturnDates = async (serialIds) => {
    if (!serialIds || serialIds.length === 0) return new Map();
    const rows = await StockMovement.aggregate([
        { $match: { type: "RETURN", serialId: { $in: serialIds } } },
        { $group: { _id: "$serialId", returnedAt: { $max: "$performedAt" } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.returnedAt]));
};

// The date Age counts from: the latest return when it's after the
// purchase date, otherwise the purchase date itself.
export const getAgeStart = (purchaseDate, lastReturnedAt) => {
    if (lastReturnedAt && new Date(lastReturnedAt) > new Date(purchaseDate)) {
        return { ageStart: lastReturnedAt, returnedAt: lastReturnedAt };
    }
    return { ageStart: purchaseDate, returnedAt: null };
};

// Floored whole days - "0 days" on the day itself, same as before.
export const daysSince = (date) => Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / MS_PER_DAY));
