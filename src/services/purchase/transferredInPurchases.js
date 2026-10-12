import Transfer from "../../models/Transfer.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";

/**
 * Purchases whose stock a branch received from another branch through a
 * transfer - e.g. Coimbatore bought a unit and transferred it to Chennai,
 * so that purchase also shows (read-only) in Chennai's purchase list.
 *
 * Only RECEIVED transfers count (the goods actually arrived), and only
 * what really arrived: a serial marked MISSING on receive, or a batch
 * line with nothing received GOOD/DAMAGED, is ignored. Each unit/batch
 * is traced back to its purchase via ProductSerial.purchaseId /
 * BatchStock.purchaseId (the source batch stock the transfer drew from).
 *
 * Returns Map<purchaseId string, { fromBranches: string[], transferNumbers: string[] }>.
 * Callers decide what "own purchase" means - a purchase the branch bought
 * itself can appear here too (bought, transferred out and back again).
 */
export const getTransferredInPurchases = async (branchId) => {
  const transfers = await Transfer.find({ destinationBranchId: branchId, status: "RECEIVED", isDeleted: { $ne: true } })
    .select("transferNumber sourceBranchName items.serials items.sourceBatches")
    .lean();
  if (transfers.length === 0) return new Map();

  const serialSources = new Map(); // productSerialId -> [transfer]
  const batchStockSources = new Map(); // batchStockId -> [transfer]
  const addSource = (map, id, transfer) => {
    const key = String(id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(transfer);
  };

  for (const transfer of transfers) {
    for (const item of transfer.items || []) {
      for (const s of item.serials || []) {
        if (s.productSerialId && s.condition !== "MISSING") addSource(serialSources, s.productSerialId, transfer);
      }
      for (const b of item.sourceBatches || []) {
        const arrived = (b.receivedGoodQuantity || 0) + (b.receivedDamagedQuantity || 0);
        if (b.batchStockId && arrived > 0) addSource(batchStockSources, b.batchStockId, transfer);
      }
    }
  }

  const [serials, batchStocks] = await Promise.all([
    serialSources.size > 0
      ? ProductSerial.find({ _id: { $in: [...serialSources.keys()] } }).select("purchaseId").lean()
      : [],
    batchStockSources.size > 0
      ? BatchStock.find({ _id: { $in: [...batchStockSources.keys()] } }).select("purchaseId").lean()
      : [],
  ]);

  const result = new Map();
  const record = (purchaseId, sourceTransfers) => {
    if (!purchaseId) return;
    const key = String(purchaseId);
    if (!result.has(key)) result.set(key, { fromBranches: new Set(), transferNumbers: new Set() });
    const entry = result.get(key);
    for (const t of sourceTransfers) {
      if (t.sourceBranchName) entry.fromBranches.add(t.sourceBranchName);
      if (t.transferNumber) entry.transferNumbers.add(t.transferNumber);
    }
  };
  for (const s of serials) record(s.purchaseId, serialSources.get(String(s._id)));
  for (const b of batchStocks) record(b.purchaseId, batchStockSources.get(String(b._id)));

  return new Map(
    [...result].map(([key, v]) => [key, { fromBranches: [...v.fromBranches], transferNumbers: [...v.transferNumbers] }])
  );
};

/** True when the purchase was bought by/for this branch itself (BRANCH purchase, or a CENTRAL purchase with items for it). */
export const purchaseBelongsToBranch = (purchase, branchId) => {
  const id = String(branchId);
  const ownBranch = purchase.branchId?._id ?? purchase.branchId;
  if (ownBranch && String(ownBranch) === id) return true;
  return (purchase.items || []).some((item) => item.branchId && String(item.branchId?._id ?? item.branchId) === id);
};
