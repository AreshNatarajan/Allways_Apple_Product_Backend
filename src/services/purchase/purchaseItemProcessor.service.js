// services/purchase/purchaseItemProcessor.service.js
//
// Shared item-validation and inventory-creation logic for purchase
// items - used by BOTH createPurchase.controller.js (the full item set
// of a brand new purchase) and updatePurchase.controller.js (new items
// appended to an existing purchase during edit). Extracted verbatim
// from createPurchase.controller.js so the two flows can never drift
// apart on GST/batch-numbering/stock-movement math - duplicating this
// logic across two files would be a far bigger risk than one shared,
// carefully-tested implementation.
//
// Two phases, matching the original inline flow exactly:
//   1. prepareItems()  - pure validation + in-memory item processing,
//      no writes except read-only Product/Branch lookups. Returns an
//      error string on the first invalid item (same messages as
//      before), or the processed items + everything phase 2 needs.
//   2. commitItemInventory() - given an ALREADY-SAVED purchase (real
//      _id) and phase 1's output, creates the actual Batch/BatchStock/
//      Inventory/ProductSerial/PendingReceive/StockMovement records,
//      and attaches batch info onto the matching purchase.items
//      entries in place (caller still owns calling purchase.save()).

import mongoose from "mongoose";
import Product from "../../models/Product.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Inventory from "../../models/Inventory.modal.js";
import Batch from "../../models/Batch.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import PendingReceive from "../../models/PendingReceive.modal.js";
import { resolveActiveBranch } from "../branchValidation.service.js";
import { recordStockMovement } from "./recordStockMovement.js";

// Atomic counter for batch numbers - global per product, not per
// branch, so a product's batch numbers stay sequential/unique across
// every branch regardless of who receives them.
const batchCounterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 },
});
const BatchCounter = mongoose.models.BatchCounter || mongoose.model("BatchCounter", batchCounterSchema);

export const getNextBatchSequence = async (productCode, session) => {
    const counter = await BatchCounter.findOneAndUpdate(
        { _id: productCode },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, session, returnDocument: "after" }
    );
    return counter.seq;
};

export const generateBatchNumber = (productCode, sequence) => {
    const paddedSeq = String(sequence).padStart(3, "0");
    return `${productCode}-B${paddedSeq}`;
};

export const generateBarcode = (batchNumber) => batchNumber;

export const calculateNonSerializedTotals = (item) => {
    const quantity = parseInt(item.quantity) || 0;
    const purchasePrice = parseFloat(item.purchasePrice) || 0;
    const gstPercent = parseFloat(item.purchaseGstPercent) || 0;

    const baseAmount = quantity * purchasePrice;
    const gstAmount = Math.round((baseAmount * gstPercent) / 100 * 100) / 100;
    const totalPrice = Math.round((baseAmount + gstAmount) * 100) / 100;

    return {
        baseAmount: Math.round(baseAmount * 100) / 100,
        gstAmount,
        totalPrice,
    };
};

// Duplicate detection spans the whole request via the caller's
// seenSerialNumbers Set (never just one item), and also checks the DB
// for a serial that already exists anywhere (any other purchase, or
// earlier in this same purchase's history for the append case).
export const validateSingleSerial = async (serialNumber, seenSerialNumbers, session) => {
    const normalized = serialNumber.trim().toUpperCase();

    if (seenSerialNumbers.has(normalized)) {
        throw new Error(`Duplicate serial number found in request: ${normalized}`);
    }
    seenSerialNumbers.add(normalized);

    const existing = await ProductSerial.findOne({
        serialNumber: normalized,
        isDeleted: false,
    }).session(session);

    if (existing) {
        throw new Error(`Serial number already exists: ${normalized}`);
    }

    return normalized;
};

export const applyRoundOff = (calculatedTotalAmount, roundOff) => {
    if (!roundOff) return { totalAmount: calculatedTotalAmount, roundOffAmount: 0 };
    const roundedTotal = Math.round(calculatedTotalAmount);
    const roundOffAmount = Math.round((roundedTotal - calculatedTotalAmount) * 100) / 100;
    return { totalAmount: roundedTotal, roundOffAmount };
};

// Resolves every distinct branch referenced by `items` (or the single
// direct-receive branch) as existing AND active. Returns
// { error } or { branchMap }.
export const resolveItemBranches = async (items, { isBranchFlow, userBranchId }) => {
    const branchIds = new Set();
    for (const item of items) {
        const branchId = isBranchFlow ? userBranchId : item.branchId;
        if (branchId) branchIds.add(branchId.toString());
    }

    const branchMap = new Map();
    for (const id of branchIds) {
        const { branch, error } = await resolveActiveBranch(id);
        if (error) return { error: `Branch ${id}: ${error}` };
        branchMap.set(id, branch);
    }
    return { branchMap };
};

// Phase 1 - validate + process every item in-memory. Does not write
// anything except read-only lookups. `itemIndexOffset` lets the caller
// tell centralBatchGroupsByProduct destinations which absolute
// purchase.items index each new item will land at (0 for a brand new
// purchase, purchase.items.length for an append).
export const prepareItems = async ({
    items,
    isSuperAdmin,
    isBranchFlow,
    isDirectReceive,
    userBranchId,
    branchMap,
    session,
    seenSerialNumbers = new Set(),
    itemIndexOffset = 0,
}) => {
    const processedItems = [];
    let calculatedTotalAmount = 0;
    const serialRecordsToCreate = [];
    const batchDataToCreate = [];
    const centralBatchGroupsByProduct = new Map();
    const pendingReceiveItemsByBranch = new Map();

    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        const product = await Product.findById(item.productId).session(session);
        if (!product) {
            return { error: `Product not found: ${item.productId}` };
        }

        let destinationBranchId = null;
        let branchName = "";
        let branchCode = "";

        if (isSuperAdmin) {
            destinationBranchId = item.branchId;
            if (!destinationBranchId) {
                return { error: `Item ${i + 1}: Branch ID is required for SUPER_ADMIN purchase` };
            }
            const branch = branchMap.get(destinationBranchId.toString());
            if (!branch) {
                return { error: `Destination branch not found: ${destinationBranchId}` };
            }
            branchName = branch.name || "";
            branchCode = branch.code || branch._id.toString().slice(-3).toUpperCase();
        } else if (isBranchFlow) {
            destinationBranchId = userBranchId;
            const branch = branchMap.get(destinationBranchId.toString());
            branchName = branch?.name || "";
            branchCode = branch?.code || destinationBranchId.toString().slice(-3).toUpperCase();
        }

        const purchasePrice = parseFloat(item.purchasePrice) || 0;
        const sellingPrice = parseFloat(item.sellingPrice) || 0;

        if (purchasePrice <= 0) {
            return { error: `Item ${i + 1}: Purchase price must be greater than 0` };
        }
        if (sellingPrice < purchasePrice) {
            return { error: `Item ${i + 1}: Selling price cannot be less than purchase price` };
        }

        if (product.isSerialized) {
            const serialNumberRaw = item.serialNumber;
            if (!serialNumberRaw || typeof serialNumberRaw !== "string" || !serialNumberRaw.trim()) {
                return { error: `Item ${i + 1}: ${product.name} - a serial number is required (one physical unit per item)` };
            }

            // Model Number is never taken from the client - it always
            // comes live from the product master (ProductSerial no
            // longer stores its own copy), same defensive-guard shape as
            // the hsnCode check right below.
            if (!product.modelNumber || !product.modelNumber.trim()) {
                return { error: `${product.name} has no Model Number set on the product master - update the product before purchasing` };
            }

            if (!product.hsnCode || !product.hsnCode.trim()) {
                return { error: `${product.name} has no HSN/SAC code set on the product master - update the product before purchasing` };
            }

            let serialNumber;
            try {
                serialNumber = await validateSingleSerial(serialNumberRaw, seenSerialNumbers, session);
            } catch (err) {
                return { error: err.message };
            }

            const itemGstApplicable = item.gstApplicable === true;
            const itemDescription = {
                main: typeof item.description?.main === "string" ? item.description.main.trim().slice(0, 1000) : "",
                second: typeof item.description?.second === "string" ? item.description.second.trim().slice(0, 1000) : "",
            };
            const itemNotes = typeof item.notes === "string" ? item.notes.trim().slice(0, 1000) : "";
            const itemMdm = !!item.mdm;
            const rawItemImages = Array.isArray(item.images) ? item.images : [];
            const itemImages = rawItemImages
                .filter((img) => img && typeof img.url === "string" && typeof img.key === "string" && img.url.trim() && img.key.trim())
                .map((img) => ({
                    url: img.url.trim(),
                    key: img.key.trim(),
                    name: typeof img.name === "string" ? img.name.trim().slice(0, 200) : "",
                }));

            const itemPurchaseGstPercent = 0;
            const itemPurchaseGstAmount = 0;
            const totalPrice = purchasePrice;
            calculatedTotalAmount += totalPrice;

            serialRecordsToCreate.push({
                productId: product._id,
                serialNumber,
                destinationBranchId,
                isDirectReceive,
                purchasePrice,
                sellingPrice,
                gstApplicable: itemGstApplicable,
                purchaseGstPercent: itemPurchaseGstPercent,
                purchaseGstAmount: itemPurchaseGstAmount,
                hsnCode: product.hsnCode || "",
                description: itemDescription,
                images: itemImages,
                notes: itemNotes,
                mdm: itemMdm,
            });

            processedItems.push({
                productId: product._id,
                quantity: 1,
                serialNumbers: [{ serialNumber }],
                batches: [],
                purchasePrice,
                sellingPrice,
                totalPrice,
                gstApplicable: itemGstApplicable,
                hsnCode: product.hsnCode || "",
                purchaseGstPercent: itemPurchaseGstPercent,
                purchaseGstAmount: itemPurchaseGstAmount,
                branchId: destinationBranchId,
            });
        } else {
            const quantity = parseInt(item.quantity) || 0;
            if (quantity <= 0) {
                return { error: `${product.name} quantity must be greater than 0` };
            }
            if (!product.hsnCode || !product.hsnCode.trim()) {
                return { error: `${product.name} has no HSN/SAC code set on the product master - update the product before purchasing` };
            }
            const hsnCode = product.hsnCode;

            const gstPercent = parseFloat(item.purchaseGstPercent) || 0;
            const calculations = calculateNonSerializedTotals(item);
            const totalPrice = calculations.totalPrice;
            calculatedTotalAmount += totalPrice;

            if (isDirectReceive) {
                const productCode = product.productCode || product._id.toString().slice(-6);
                batchDataToCreate.push({
                    productId: product._id,
                    productCode,
                    branchId: destinationBranchId,
                    purchasePrice,
                    sellingPrice,
                    quantity,
                    gstApplicable: true,
                    purchaseGstPercent: gstPercent,
                });
            }

            const itemIndex = itemIndexOffset + processedItems.length;
            processedItems.push({
                productId: product._id,
                quantity,
                serialNumbers: [],
                batches: [],
                purchasePrice,
                sellingPrice,
                totalPrice,
                gstApplicable: true,
                hsnCode,
                purchaseGstPercent: gstPercent,
                purchaseGstAmount: calculations.gstAmount,
                branchId: destinationBranchId,
            });

            if (isSuperAdmin) {
                const groupKey = `${product._id.toString()}::${purchasePrice}::${sellingPrice}::${gstPercent}`;
                if (!centralBatchGroupsByProduct.has(groupKey)) {
                    centralBatchGroupsByProduct.set(groupKey, {
                        productId: product._id,
                        productName: product.name,
                        productCode: product.productCode || product._id.toString().slice(-6),
                        purchasePrice,
                        sellingPrice,
                        purchaseGstPercent: gstPercent,
                        totalQuantity: 0,
                        destinations: [],
                    });
                }
                const group = centralBatchGroupsByProduct.get(groupKey);
                group.totalQuantity += quantity;
                group.destinations.push({
                    branchId: destinationBranchId,
                    branchName,
                    branchCode,
                    quantity,
                    itemIndex,
                });
            }
        }
    }

    return {
        processedItems,
        calculatedTotalAmount,
        serialRecordsToCreate,
        batchDataToCreate,
        centralBatchGroupsByProduct,
        pendingReceiveItemsByBranch,
    };
};

// Phase 2 - given an already-saved `purchase` (real _id) and phase 1's
// output, creates the real inventory records and attaches batch info
// onto the matching purchase.items entries in place. Caller still owns
// the actual purchase.save() call(s) - same two-save pattern as the
// original inline flow (batch info attach needs a real batchId first,
// which needs purchase._id first).
export const commitItemInventory = async ({
    purchase,
    phase1,
    isSuperAdmin,
    isDirectReceive,
    purchaseNumber,
    user,
    session,
}) => {
    const { serialRecordsToCreate, batchDataToCreate, centralBatchGroupsByProduct } = phase1;

    // Copied onto every Batch/BatchStock/ProductSerial this call creates,
    // and used to pick the matching StockMovement type below - every
    // existing caller (createPurchase/updatePurchase/bulkReceive/
    // receiveTransfer) never sets purchase.source, so this is always
    // "VENDOR_PURCHASE" for them, identical to before this field existed.
    // Only tradeInProcessor.service.js ever passes a purchase with
    // source: "CUSTOMER_EXCHANGE".
    const stockSource = purchase.source || "VENDOR_PURCHASE";
    const receiveMovementType = stockSource === "CUSTOMER_EXCHANGE" ? "CUSTOMER_EXCHANGE_RECEIVE" : "PURCHASE_RECEIVE_DIRECT";

    // ---- Direct-receive batches (BRANCH_ADMIN/STAFF) ----
    const createdBatches = [];
    if (isDirectReceive && batchDataToCreate.length > 0) {
        for (const batchData of batchDataToCreate) {
            const sequence = await getNextBatchSequence(batchData.productCode, session);
            const batchNumber = generateBatchNumber(batchData.productCode, sequence);

            const batch = new Batch({
                batchNumber,
                branchId: batchData.branchId,
                productId: batchData.productId,
                purchaseId: purchase._id,
                source: stockSource,
                purchasePrice: batchData.purchasePrice,
                sellingPrice: batchData.sellingPrice,
                quantity: batchData.quantity,
                availableQuantity: batchData.quantity,
                gstApplicable: batchData.gstApplicable,
                purchaseGstPercent: batchData.purchaseGstPercent,
                status: "ACTIVE",
                notes: `Created from purchase ${purchaseNumber}`,
            });
            await batch.save({ session });

            const barcode = generateBarcode(batchNumber);
            const batchStock = new BatchStock({
                batchId: batch._id,
                productId: batchData.productId,
                branchId: batchData.branchId,
                batchNumber,
                barcode,
                productCode: batchData.productCode,
                purchaseId: purchase._id,
                source: stockSource,
                quantity: batchData.quantity,
                availableQuantity: batchData.quantity,
                purchasePrice: batchData.purchasePrice,
                sellingPrice: batchData.sellingPrice,
                gstApplicable: batchData.gstApplicable,
                purchaseGstPercent: batchData.purchaseGstPercent,
                soldQuantity: 0,
                damagedQuantity: 0,
                status: "ACTIVE",
            });
            await batchStock.save({ session });

            await recordStockMovement({
                type: receiveMovementType,
                productId: batchData.productId,
                branchId: batchData.branchId,
                batchId: batch._id,
                quantityDelta: batchData.quantity,
                resultingAvailableQuantity: batchStock.availableQuantity,
                unitCost: batchData.purchasePrice,
                gstApplicable: batchData.gstApplicable,
                gstPercent: batchData.purchaseGstPercent,
                referenceType: "Purchase",
                referenceId: purchase._id,
                performedBy: user._id,
                performedByName: user.name || "",
                notes: `Batch ${batchNumber} received from purchase ${purchaseNumber}`,
                session,
            });

            createdBatches.push({
                productId: batchData.productId,
                branchId: batchData.branchId,
                batchId: batch._id,
                batchNumber,
                quantity: batchData.quantity,
                purchasePrice: batchData.purchasePrice,
                sellingPrice: batchData.sellingPrice,
            });

            const inventory = await Inventory.findOne({ branchId: batchData.branchId, productId: batchData.productId }).session(session);
            if (inventory) {
                inventory.quantity += batchData.quantity;
                await inventory.save({ session });
            } else {
                await Inventory.create([{ branchId: batchData.branchId, productId: batchData.productId, quantity: batchData.quantity }], { session });
            }
        }

        for (const item of purchase.items) {
            const matchingBatch = createdBatches.find(
                (b) => b.productId.toString() === item.productId.toString() && b.branchId.toString() === item.branchId?.toString() && (!item.batches || item.batches.length === 0)
            );
            if (matchingBatch) {
                item.batches = [{
                    batchNumber: matchingBatch.batchNumber,
                    quantity: matchingBatch.quantity,
                    purchasePrice: matchingBatch.purchasePrice,
                    sellingPrice: matchingBatch.sellingPrice,
                    batchId: matchingBatch.batchId,
                }];
            }
        }
    }

    // ---- CENTRAL batches (SUPER_ADMIN) - PendingReceive, no BatchStock yet ----
    const centralBatchesByGroupKey = new Map();
    if (isSuperAdmin && centralBatchGroupsByProduct.size > 0) {
        const pendingReceiveItemsByBranch = new Map();

        for (const [groupKey, group] of centralBatchGroupsByProduct.entries()) {
            const sequence = await getNextBatchSequence(group.productCode, session);
            const batchNumber = generateBatchNumber(group.productCode, sequence);

            const batch = new Batch({
                batchNumber,
                productId: group.productId,
                purchaseId: purchase._id,
                purchasePrice: group.purchasePrice,
                sellingPrice: group.sellingPrice,
                quantity: group.totalQuantity,
                gstApplicable: true,
                purchaseGstPercent: group.purchaseGstPercent,
                status: "ACTIVE",
                notes: `Created from purchase ${purchaseNumber} (CENTRAL - pending receive at destination branch(es))`,
            });
            await batch.save({ session });

            centralBatchesByGroupKey.set(groupKey, { batchId: batch._id, batchNumber });
        }

        for (const [groupKey, group] of centralBatchGroupsByProduct.entries()) {
            const { batchId, batchNumber } = centralBatchesByGroupKey.get(groupKey);

            for (const dest of group.destinations) {
                purchase.items[dest.itemIndex].batches = [{
                    batchNumber,
                    quantity: dest.quantity,
                    purchasePrice: group.purchasePrice,
                    sellingPrice: group.sellingPrice,
                    batchId,
                }];

                const key = dest.branchId.toString();
                if (!pendingReceiveItemsByBranch.has(key)) {
                    pendingReceiveItemsByBranch.set(key, {
                        branchId: dest.branchId,
                        branchName: dest.branchName,
                        items: [],
                    });
                }
                pendingReceiveItemsByBranch.get(key).items.push({
                    productId: group.productId,
                    productName: group.productName,
                    batchId,
                    batchNumber,
                    orderedQuantity: dest.quantity,
                    receivedQuantity: 0,
                    damagedQuantity: 0,
                    rejectedQuantity: 0,
                    status: "PENDING",
                });
            }
        }

        for (const pendingData of pendingReceiveItemsByBranch.values()) {
            if (pendingData.items.length > 0) {
                await PendingReceive.create([{
                    purchaseId: purchase._id,
                    branchId: pendingData.branchId,
                    items: pendingData.items,
                    status: "PENDING",
                    createdBy: user._id,
                    notes: `Pending receive for branch ${pendingData.branchName}`,
                }], { session });
            }
        }
    }

    // ---- ProductSerial records (both flows) ----
    if (serialRecordsToCreate.length > 0) {
        const createdSerialRecords = serialRecordsToCreate.map((serialData) => ({
            doc: new ProductSerial({
                productId: serialData.productId,
                purchaseId: purchase._id,
                source: stockSource,
                serialNumber: serialData.serialNumber,
                purchasePrice: serialData.purchasePrice,
                sellingPrice: serialData.sellingPrice,
                status: serialData.isDirectReceive ? "AVAILABLE" : "ASSIGNED",
                currentBranchId: serialData.isDirectReceive ? serialData.destinationBranchId : null,
                assignedBranchId: serialData.isDirectReceive ? null : serialData.destinationBranchId,
                receivedAt: serialData.isDirectReceive ? new Date() : null,
                gstApplicable: serialData.gstApplicable,
                purchaseGstPercent: serialData.purchaseGstPercent,
                purchaseGstAmount: serialData.purchaseGstAmount,
                hsnCode: serialData.hsnCode,
                description: serialData.description || { main: "", second: "" },
                images: serialData.images || [],
                notes: serialData.notes || "",
                mdm: serialData.mdm || false,
            }),
            serialData,
        }));

        const insertedSerials = await ProductSerial.insertMany(createdSerialRecords.map((r) => r.doc), { session });

        for (let i = 0; i < insertedSerials.length; i++) {
            const inserted = insertedSerials[i];
            const { serialData } = createdSerialRecords[i];
            if (inserted.status === "AVAILABLE") {
                await recordStockMovement({
                    type: receiveMovementType,
                    productId: inserted.productId,
                    branchId: inserted.currentBranchId,
                    serialId: inserted._id,
                    quantityDelta: 1,
                    unitCost: serialData.purchasePrice,
                    gstApplicable: serialData.gstApplicable,
                    gstPercent: 0,
                    referenceType: "Purchase",
                    referenceId: purchase._id,
                    performedBy: user._id,
                    performedByName: user.name || "",
                    notes: `Serial ${inserted.serialNumber} received from purchase ${purchaseNumber}`,
                    session,
                });
            }
        }
    }

    return { createdBatches, centralBatchesByGroupKey };
};
