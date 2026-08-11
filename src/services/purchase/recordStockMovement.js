// services/purchase/recordStockMovement.js
import StockMovement from "../../models/StockMovement.model.js";

// Thin wrapper around StockMovement creation. Every place stock actually
// becomes available (or leaves) must call this in the same transaction
// as the mutation itself - this is the "historical record" half of the
// current-state/historical-record split (BatchStock.availableQuantity /
// ProductSerial.status answer "what do I have right now"; StockMovement
// answers "how did it get to that number, and when").
export const recordStockMovement = async ({
    type,
    productId,
    branchId,
    batchId = null,
    serialId = null,
    quantityDelta,
    resultingAvailableQuantity = null,
    unitCost = 0,
    gstApplicable = false,
    gstPercent = 0,
    branchFrom = null,
    branchTo = null,
    referenceType,
    referenceId,
    performedBy,
    performedByName = "",
    notes = "",
    session,
}) => {
    const [movement] = await StockMovement.create(
        [
            {
                type,
                productId,
                branchId,
                batchId,
                serialId,
                quantityDelta,
                resultingAvailableQuantity,
                unitCost,
                gstApplicable,
                gstPercent,
                branchFrom,
                branchTo,
                referenceType,
                referenceId,
                performedBy,
                performedByName,
                notes,
            },
        ],
        { session }
    );

    return movement;
};
