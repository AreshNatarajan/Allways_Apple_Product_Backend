// services/pendingReceive/receiveStatusHelper.js

// Single source of truth for "what status does this receive progress
// represent" - used identically for a single PendingReceive item line,
// a whole PendingReceive document, a purchase+branch row merged across
// serialized + non-serialized sources (the list endpoint), and a
// purchase's overall cross-branch rollup (Purchase.overallReceiveStatus).
//
// This works for all four because, under the invariant this module
// enforces elsewhere (received+damaged+missing+rejected can never
// exceed assigned, for any one line), summing every quantity bucket
// across N lines and applying this same per-line formula to the totals
// produces the identical result to evaluating each line individually
// and combining - so one function serves every granularity, not just
// the leaf case.
//
// Precedence when everything assigned has been processed:
//   1. 100% damaged      -> DAMAGED
//   2. 100% missing      -> MISSING
//   3. 100% rejected     -> REJECTED
//   4. any mix of good/damaged/missing/rejected -> PARTIAL (matches this
//      codebase's pre-existing bulkReceive convention: COMPLETED is
//      reserved for "fully processed AND entirely good", not merely
//      "nothing left pending")
//   5. 100% good          -> COMPLETED (doc/purchase/list granularity)
//      or RECEIVED (single item-line granularity)
export const deriveStatus = ({
  assignedQty = 0,
  receivedQty = 0,
  damagedQty = 0,
  missingQty = 0,
  rejectedQty = 0,
  // "RECEIVED" for a single PendingReceive item line, "COMPLETED" for a
  // PendingReceive document / list row / purchase rollup - the two
  // enums differ only in this one terminal label.
  fullyGoodLabel = "COMPLETED",
}) => {
  const totalProcessed = receivedQty + damagedQty + missingQty + rejectedQty;

  if (totalProcessed <= 0) return "PENDING";

  if (totalProcessed < assignedQty) return "PARTIAL";

  // Fully processed (totalProcessed >= assignedQty, and by the
  // never-over-receive invariant totalProcessed === assignedQty here).
  if (damagedQty > 0 && receivedQty === 0 && missingQty === 0 && rejectedQty === 0) {
    return "DAMAGED";
  }
  if (missingQty > 0 && receivedQty === 0 && damagedQty === 0 && rejectedQty === 0) {
    return "MISSING";
  }
  if (rejectedQty > 0 && receivedQty === 0 && damagedQty === 0 && missingQty === 0) {
    return "REJECTED";
  }
  if (damagedQty > 0 || missingQty > 0 || rejectedQty > 0) {
    return "PARTIAL";
  }
  return fullyGoodLabel;
};

// Convenience wrapper for a single PendingReceive item line (or a
// single ProductSerial treated as a 1-unit line) - same math, terminal
// label is "RECEIVED" instead of "COMPLETED".
export const deriveLineStatus = (totals) => deriveStatus({ ...totals, fullyGoodLabel: "RECEIVED" });

// Convenience wrapper for a PendingReceive document, summing its own
// items[] first.
export const deriveDocStatus = (items = []) => {
  const totals = items.reduce(
    (acc, item) => ({
      assignedQty: acc.assignedQty + (item.orderedQuantity || 0),
      receivedQty: acc.receivedQty + (item.receivedQuantity || 0),
      damagedQty: acc.damagedQty + (item.damagedQuantity || 0),
      missingQty: acc.missingQty + (item.missingQuantity || 0),
      rejectedQty: acc.rejectedQty + (item.rejectedQuantity || 0),
    }),
    { assignedQty: 0, receivedQty: 0, damagedQty: 0, missingQty: 0, rejectedQty: 0 }
  );
  return deriveStatus(totals);
};

export const receivePercent = ({ assignedQty = 0, receivedQty = 0 }) => {
  if (assignedQty <= 0) return 0;
  return Math.round((receivedQty / assignedQty) * 10000) / 100;
};
