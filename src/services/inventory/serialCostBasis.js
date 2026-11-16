// services/inventory/serialCostBasis.js
//
// A serialized unit has TWO cost figures, deliberately kept apart:
//
//   ProductSerial.purchasePrice    ORIGINAL historical purchase cost of
//                                  the physical unit. Never changed by a
//                                  Type 2 (showroom re-exchange). Purchase
//                                  history, purchase edits and vendor
//                                  returns keep reading this.
//
//   ProductSerial.currentCostBasis CURRENT inventory acquisition cost.
//                                  null on every unit that has never been
//                                  re-acquired (all existing serials, and
//                                  every new Purchase / Type 1 trade-in
//                                  serial) - the effective cost is then
//                                  simply purchasePrice, so a later edit
//                                  of purchasePrice still flows through
//                                  and nothing needs a backfill. A Type 2
//                                  exchange sets it to the staff-entered
//                                  exchange value.
//
// Anything that needs "what does this unit cost us if we sell it now"
// (a sale line, a replacement unit, stock valuation) must use
// effectiveSerialCost / COST_BASIS_EXPR. Anything that is about the
// original purchase keeps using purchasePrice. A Sale line copies the
// effective cost at the moment of sale, so history never changes.

export const effectiveSerialCost = (serial) => {
  const basis = serial?.currentCostBasis;
  if (basis !== null && basis !== undefined && Number.isFinite(Number(basis))) return Number(basis);
  return Number(serial?.purchasePrice) || 0;
};

// Same rule for aggregation pipelines ($sum: COST_BASIS_EXPR).
export const COST_BASIS_EXPR = { $ifNull: ["$currentCostBasis", "$purchasePrice"] };
