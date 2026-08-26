// controllers/pendingReceives/bulkReceive.controller.js
import mongoose from "mongoose";
import Purchase from "../../models/Purchase.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import PendingReceive from "../../models/PendingReceive.modal.js";
import Inventory from "../../models/Inventory.modal.js";
import ReceiveHistory from "../../models/ReceiveHistory.modal.js";
import Product from "../../models/Product.modal.js";
import Branch from "../../models/Branch.modal.js";
import User from "../../models/User.js";
import Batch from "../../models/Batch.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { deriveLineStatus, deriveDocStatus, deriveStatus } from "../../services/pendingReceive/receiveStatusHelper.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

const VALID_SERIAL_CONDITIONS = ["GOOD", "DAMAGED", "MISSING"];
// Statuses that mean "nothing left to process here" - a receive
// request touching a PendingReceive doc already in one of these must
// be rejected outright ("Pending Receive is still active" check).
const TERMINAL_PENDING_RECEIVE_STATUSES = ["COMPLETED", "DAMAGED", "MISSING", "REJECTED"];

// ============================================================
// Recomputes Purchase.overallReceiveStatus across EVERY destination
// branch this purchase assigned stock to (not just the branch being
// received into by this call) - a CENTRAL purchase can span several
// branches, so "overall" is a cross-branch rollup, not a per-branch
// number. Must run inside the same transaction/session as the mutation
// that triggered it, so the Purchase document never reflects a receive
// event that itself got rolled back.
// ============================================================
const recomputeOverallReceiveStatus = async (purchaseId, session) => {
    const [pendingReceives, serials] = await Promise.all([
        PendingReceive.find({ purchaseId, isDeleted: false }).select("items").session(session).lean(),
        ProductSerial.find({ purchaseId, isDeleted: false, assignedBranchId: { $ne: null } })
            .select("status receivedAt")
            .session(session)
            .lean(),
    ]);

    if (pendingReceives.length === 0 && serials.length === 0) {
        // BRANCH (direct-receive) purchase, or nothing ever assigned out -
        // nothing to roll up; leave the default PENDING as-is.
        return;
    }

    const totals = { assignedQty: 0, receivedQty: 0, damagedQty: 0, missingQty: 0, rejectedQty: 0 };
    for (const pr of pendingReceives) {
        for (const item of pr.items) {
            totals.assignedQty += item.orderedQuantity || 0;
            totals.receivedQty += item.receivedQuantity || 0;
            totals.damagedQty += item.damagedQuantity || 0;
            totals.missingQty += item.missingQuantity || 0;
            totals.rejectedQty += item.rejectedQuantity || 0;
        }
    }
    for (const s of serials) {
        totals.assignedQty += 1;
        if (s.receivedAt && s.status === "AVAILABLE") totals.receivedQty += 1;
        else if (s.status === "DAMAGED") totals.damagedQty += 1;
        else if (s.status === "MISSING") totals.missingQty += 1;
    }

    const overallReceiveStatus = deriveStatus(totals);
    await Purchase.findByIdAndUpdate(purchaseId, { overallReceiveStatus }, { session });
};

export const bulkReceiveController = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    const rollback = async (message, statusCode = 400) => {
        await session.abortTransaction();
        session.endSession();
        return errorResponse(res, message, statusCode);
    };

    try {
        const { purchaseId, items, notes } = req.body;
        const user = req.user;
        const userBranchId = user?.branchId;

        if (!userBranchId) {
            return rollback("Branch not assigned to user", 400);
        }
        // pendingReceive.receive per-user grant (defaults to true for
        // BRANCH_ADMIN/STAFF today, can be revoked) - see
        // config/permissionCatalog.js. No SUPER_ADMIN bypass needed here:
        // SUPER_ADMIN never reaches this far, they have no branchId and
        // already fail the check above (unrelated, pre-existing rule -
        // only the destination branch can receive stock).
        if (user.permissions?.["pendingReceive.receive"] !== true) {
            return rollback("You don't have permission to perform this action", 403);
        }
        if (!purchaseId || !mongoose.Types.ObjectId.isValid(purchaseId)) {
            return rollback("Valid purchaseId is required", 400);
        }
        if (!Array.isArray(items) || items.length === 0) {
            return rollback("No items provided to receive", 400);
        }

        // ============================================================
        // ✅ GET PURCHASE DETAILS (inside the transaction's snapshot)
        // ============================================================
        const purchase = await Purchase.findById(purchaseId)
            .populate('vendorId', 'name phone email')
            .session(session);

        if (!purchase) {
            return rollback("Purchase not found", 404);
        }

        // "Pending Receive is still active" (purchase-level gate) - a
        // DRAFT purchase has nothing finalized to receive yet, and a
        // CANCELLED purchase's assignments are void.
        if (purchase.status !== "COMPLETED") {
            return rollback(`Cannot receive against a purchase with status "${purchase.status}"`, 400);
        }

        // ============================================================
        // ✅ GET BRANCH DETAILS
        // ============================================================
        const branch = await Branch.findById(userBranchId)
            .select('name code')
            .session(session)
            .lean();

        if (!branch) {
            return rollback("Branch not found", 404);
        }

        // ============================================================
        // ✅ GET USER DETAILS
        // ============================================================
        const userDetails = await User.findById(user._id)
            .select('name email')
            .session(session)
            .lean();

        // ============================================================
        // ✅ SEPARATE ITEMS
        // ============================================================
        const serializedItems = items.filter(item => item.isSerialized && item.serialNumber);
        const nonSerializedItems = items.filter(item =>
            !item.isSerialized &&
            ((item.receivedQuantity || 0) > 0 || (item.damagedQuantity || 0) > 0 || (item.missingQuantity || 0) > 0 || (item.rejectedQuantity || 0) > 0)
        );

        const errors = [];
        const successfulSerials = [];
        const successfulNonSerialized = [];

        // ============================================================
        // ✅ VALIDATE SERIALIZED ITEMS
        // ============================================================
        for (const item of serializedItems) {
            const condition = (item.condition || "GOOD").toUpperCase();
            if (!VALID_SERIAL_CONDITIONS.includes(condition)) {
                errors.push(`❌ Serial number "${item.serialNumber}": invalid condition "${item.condition}" (must be GOOD, DAMAGED, or MISSING)`);
                continue;
            }

            // 1. Check if serial exists (unknown serial rejection)
            const serialRecord = await ProductSerial.findOne({
                serialNumber: item.serialNumber.trim().toUpperCase(),
                isDeleted: false,
            }).session(session);

            if (!serialRecord) {
                errors.push(`❌ Serial number "${item.serialNumber}" does not exist in our system`);
                continue;
            }

            // 2. Check if serial belongs to this purchase
            if (serialRecord.purchaseId.toString() !== purchaseId.toString()) {
                errors.push(`❌ Serial number "${item.serialNumber}" belongs to a different purchase`);
                continue;
            }

            // 3. Check if serial is assigned to THIS authenticated branch
            // (wrong-branch rejection)
            if (!serialRecord.assignedBranchId) {
                errors.push(`❌ Serial number "${item.serialNumber}" is not assigned to any branch`);
                continue;
            }

            if (serialRecord.assignedBranchId.toString() !== userBranchId.toString()) {
                errors.push(`❌ Serial number "${item.serialNumber}" is assigned to a different branch and cannot be received here`);
                continue;
            }

            // 4. Check if already received (duplicate-receive rejection)
            if (serialRecord.receivedAt !== null) {
                errors.push(`❌ Serial number "${item.serialNumber}" was already received`);
                continue;
            }

            // 5. Reject if already SOLD or moved on some other way -
            // ASSIGNED/IN_TRANSIT is the only state a serial can still be
            // received from. Anything else (SOLD, DAMAGED, MISSING,
            // AVAILABLE at another point) is rejected here by construction.
            if (!["ASSIGNED", "IN_TRANSIT"].includes(serialRecord.status)) {
                errors.push(`❌ Serial number "${item.serialNumber}" has status "${serialRecord.status}" and cannot be received (already sold, transferred, or processed)`);
                continue;
            }

            const product = await Product.findById(serialRecord.productId)
                .select('name productCode')
                .session(session)
                .lean();

            successfulSerials.push({
                serialNumber: serialRecord.serialNumber,
                condition,
                remarks: item.remarks || "",
                productId: serialRecord.productId,
                productName: product?.name || 'Unknown Product',
                productCode: product?.productCode || '',
                validatedRecord: serialRecord,
            });
        }

        // ============================================================
        // ✅ VALIDATE NON-SERIALIZED ITEMS
        // ============================================================
        // A single request only ever targets one purchase+branch, so at
        // most one PendingReceive document is relevant - fetched once
        // and reused for every non-serialized line below.
        let pendingReceive = null;
        if (nonSerializedItems.length > 0) {
            pendingReceive = await PendingReceive.findOne({
                purchaseId,
                branchId: userBranchId,
                isDeleted: false,
            }).session(session);

            if (!pendingReceive) {
                return rollback(`No pending receive record found for purchase "${purchase.purchaseNumber}" at this branch`, 404);
            }

            // "Pending Receive is still active" - reject outright if this
            // whole receive record is already closed out.
            if (TERMINAL_PENDING_RECEIVE_STATUSES.includes(pendingReceive.status)) {
                return rollback(`This pending receive is already ${pendingReceive.status.toLowerCase()} - nothing left to process`, 400);
            }
        }

        for (const item of nonSerializedItems) {
            // Resolve the target line: batchNumber (scan-first UX) takes
            // priority when provided, falling back to productId.
            const pendingItem = item.batchNumber
                ? pendingReceive.items.find(i => (i.batchNumber || "").toUpperCase() === item.batchNumber.trim().toUpperCase())
                : pendingReceive.items.find(i => i.productId.toString() === item.productId);

            if (!pendingItem) {
                const label = item.batchNumber ? `Batch "${item.batchNumber}"` : `Product "${item.productName || item.productId}"`;
                errors.push(`❌ ${label} not found in this pending receive (wrong branch or wrong purchase)`);
                continue;
            }

            const receivedQty = Number(item.receivedQuantity) || 0;
            const damagedQty = Number(item.damagedQuantity) || 0;
            const missingQty = Number(item.missingQuantity) || 0;
            const rejectedQty = Number(item.rejectedQuantity) || 0;
            const totalProcessing = receivedQty + damagedQty + missingQty + rejectedQty;

            if (totalProcessing <= 0) {
                errors.push(`❌ "${pendingItem.productName || 'Product'}": quantity must be greater than 0`);
                continue;
            }

            // Never allow Received Qty > Assigned Qty (across all four
            // outcome buckets combined).
            const currentProcessed =
                (pendingItem.receivedQuantity || 0) + (pendingItem.damagedQuantity || 0) + (pendingItem.missingQuantity || 0) + (pendingItem.rejectedQuantity || 0);
            const newTotalProcessed = currentProcessed + totalProcessing;

            if (newTotalProcessed > pendingItem.orderedQuantity) {
                const remaining = pendingItem.orderedQuantity - currentProcessed;
                errors.push(`❌ "${pendingItem.productName || 'Product'}": cannot process ${totalProcessing} units, only ${remaining} remaining`);
                continue;
            }

            const product = await Product.findById(item.productId || pendingItem.productId)
                .select('name productCode')
                .session(session)
                .lean();

            successfulNonSerialized.push({
                productId: (item.productId || pendingItem.productId).toString(),
                productName: product?.name || item.productName || pendingItem.productName || 'Unknown Product',
                productCode: product?.productCode || '',
                receivedQuantity: receivedQty,
                damagedQuantity: damagedQty,
                missingQuantity: missingQty,
                rejectedQuantity: rejectedQty,
                remarks: item.remarks || "",
                orderedQuantity: pendingItem.orderedQuantity,
                pendingItem,
            });
        }

        // ============================================================
        // ✅ CHECK FOR VALIDATION ERRORS
        // ============================================================
        if (errors.length > 0) {
            return rollback(errors.join("\n"), 400);
        }

        // ============================================================
        // ✅ PROCESS SERIALIZED ITEMS
        // ============================================================
        const processedSerials = [];
        const serialStockMovementsToRecord = [];

        for (const item of successfulSerials) {
            const serialRecord = item.validatedRecord;

            const serialStatus = item.condition === "GOOD" ? "AVAILABLE" : item.condition; // AVAILABLE | DAMAGED | MISSING
            const now = new Date();

            serialRecord.status = serialStatus;
            serialRecord.currentBranchId = userBranchId;
            serialRecord.receivedAt = now;
            if (item.condition !== "GOOD") {
                serialRecord.remarks = item.remarks || "";
                serialRecord.conditionUpdatedBy = user._id;
                serialRecord.conditionUpdatedAt = now;
            }
            await serialRecord.save({ session });

            // Inventory (legacy dual-write collection) and StockMovement
            // only for GOOD receives - a damaged/missing unit never
            // enters available/sellable stock, so neither should move.
            if (item.condition === "GOOD") {
                await Inventory.findOneAndUpdate(
                    { branchId: userBranchId, productId: serialRecord.productId },
                    { $inc: { quantity: 1 } },
                    { upsert: true, new: true, session }
                );

                serialStockMovementsToRecord.push({
                    productId: serialRecord.productId,
                    branchId: userBranchId,
                    serialId: serialRecord._id,
                    quantityDelta: 1,
                    resultingAvailableQuantity: null,
                    unitCost: serialRecord.purchasePrice,
                    gstApplicable: serialRecord.gstApplicable,
                    gstPercent: serialRecord.purchaseGstPercent,
                    notes: `Serial ${serialRecord.serialNumber} received at branch (purchase ${purchase.purchaseNumber})`,
                });
            }

            processedSerials.push({
                serialNumber: serialRecord.serialNumber,
                status: serialRecord.status,
                receivedAt: serialRecord.receivedAt,
                productId: serialRecord.productId,
                productName: item.productName,
                productCode: item.productCode,
                _id: serialRecord._id,
                condition: item.condition,
            });
        }

        // ============================================================
        // ✅ PROCESS NON-SERIALIZED ITEMS
        // ============================================================
        const processedNonSerialized = [];
        let totalGoodReceived = 0;
        let totalDamagedReceived = 0;
        let totalMissingReceived = 0;
        let totalRejectedReceived = 0;
        // StockMovement rows for BatchStock - deferred until after
        // ReceiveHistory is created below, since ReceiveHistory's own
        // _id (one per bulkReceive call) is the correct referenceId -
        // using the long-lived PendingReceive._id would collide with
        // StockMovement's own duplicate-movement unique index the
        // moment the same batch is partially received a second time.
        const batchStockMovementsToRecord = [];

        for (const item of successfulNonSerialized) {
            const pendingItem = item.pendingItem;

            pendingItem.receivedQuantity = (pendingItem.receivedQuantity || 0) + item.receivedQuantity;
            pendingItem.damagedQuantity = (pendingItem.damagedQuantity || 0) + item.damagedQuantity;
            pendingItem.missingQuantity = (pendingItem.missingQuantity || 0) + item.missingQuantity;
            pendingItem.rejectedQuantity = (pendingItem.rejectedQuantity || 0) + item.rejectedQuantity;

            pendingItem.status = deriveLineStatus({
                assignedQty: pendingItem.orderedQuantity,
                receivedQty: pendingItem.receivedQuantity,
                damagedQty: pendingItem.damagedQuantity,
                missingQty: pendingItem.missingQuantity,
                rejectedQty: pendingItem.rejectedQuantity,
            });

            if (item.damagedQuantity > 0 || item.missingQuantity > 0 || item.rejectedQuantity > 0) {
                pendingItem.remarks = item.remarks || pendingItem.remarks || "";
                pendingItem.statusUpdatedBy = user._id;
                pendingItem.statusUpdatedAt = new Date();
            }

            // ✅ Inventory (legacy dual-write) - GOOD quantity only
            if (item.receivedQuantity > 0) {
                await Inventory.findOneAndUpdate(
                    { branchId: userBranchId, productId: item.productId },
                    { $inc: { quantity: item.receivedQuantity } },
                    { upsert: true, new: true, session }
                );
            }

            // ============================================================
            // ✅ ACTIVATE/UPDATE BATCHSTOCK - the batch itself (batch
            // number, barcode, cost basis) was already created at CENTRAL
            // purchase time; this is where its stock actually becomes
            // real at THIS branch. Damaged/missing quantity is tracked on
            // BatchStock.damagedQuantity but never added to
            // availableQuantity - never increases sellable Inventory.
            // ============================================================
            if (pendingItem.batchId && (item.receivedQuantity + item.damagedQuantity) > 0) {
                const batch = await Batch.findById(pendingItem.batchId).session(session);

                if (batch) {
                    let batchStock = await BatchStock.findOne({
                        batchId: batch._id,
                        branchId: userBranchId,
                    }).session(session);

                    if (batchStock) {
                        batchStock.quantity += item.receivedQuantity + item.damagedQuantity;
                        batchStock.availableQuantity += item.receivedQuantity;
                        batchStock.damagedQuantity += item.damagedQuantity;
                        await batchStock.save({ session });
                    } else {
                        batchStock = new BatchStock({
                            batchId: batch._id,
                            productId: item.productId,
                            branchId: userBranchId,
                            batchNumber: batch.batchNumber,
                            barcode: batch.batchNumber,
                            productCode: item.productCode || "",
                            purchaseId: pendingReceive.purchaseId,
                            quantity: item.receivedQuantity + item.damagedQuantity,
                            availableQuantity: item.receivedQuantity,
                            damagedQuantity: item.damagedQuantity,
                            soldQuantity: 0,
                            purchasePrice: batch.purchasePrice,
                            sellingPrice: batch.sellingPrice,
                            gstApplicable: batch.gstApplicable,
                            purchaseGstPercent: batch.purchaseGstPercent,
                            status: "ACTIVE",
                        });
                        await batchStock.save({ session });
                    }

                    if (item.receivedQuantity > 0) {
                        batchStockMovementsToRecord.push({
                            productId: item.productId,
                            branchId: userBranchId,
                            batchId: batch._id,
                            quantityDelta: item.receivedQuantity,
                            resultingAvailableQuantity: batchStock.availableQuantity,
                            unitCost: batch.purchasePrice,
                            gstApplicable: batch.gstApplicable,
                            gstPercent: batch.purchaseGstPercent,
                            notes: `${item.receivedQuantity} unit(s) of batch ${batch.batchNumber} received at branch (purchase ${pendingReceive.purchaseId})`,
                        });
                    }
                }
            }

            totalGoodReceived += item.receivedQuantity;
            totalDamagedReceived += item.damagedQuantity;
            totalMissingReceived += item.missingQuantity;
            totalRejectedReceived += item.rejectedQuantity;

            processedNonSerialized.push({
                productId: item.productId,
                productName: item.productName,
                productCode: item.productCode,
                receivedQuantity: item.receivedQuantity,
                damagedQuantity: item.damagedQuantity,
                missingQuantity: item.missingQuantity,
                rejectedQuantity: item.rejectedQuantity,
                orderedQuantity: item.orderedQuantity,
                status: pendingItem.status,
            });
        }

        // ✅ Recompute this branch's PendingReceive document status from
        // its own items (shared helper - same rules as the list/detail
        // endpoints).
        if (pendingReceive) {
            pendingReceive.status = deriveDocStatus(pendingReceive.items);
            if (pendingReceive.status !== "PENDING" && pendingReceive.status !== "PARTIAL") {
                pendingReceive.receivedAt = new Date();
                pendingReceive.completedBy = user._id;
            }
            await pendingReceive.save({ session });
        }

        // ============================================================
        // ✅ CREATE RECEIVE HISTORY
        // ============================================================
        const historySerials = processedSerials.map(item => ({
            productId: item.productId,
            productName: item.productName,
            productCode: item.productCode,
            isSerialized: true,
            orderedQuantity: 1,
            receivedQuantity: item.condition === "GOOD" ? 1 : 0,
            damagedQuantity: item.condition === "DAMAGED" ? 1 : 0,
            missingQuantity: item.condition === "MISSING" ? 1 : 0,
            rejectedQuantity: 0,
            serialNumbers: [{
                serialNumber: item.serialNumber,
                productSerialId: item._id,
                status: item.condition === "GOOD" ? "AVAILABLE" : item.condition,
            }],
            status: item.condition === "GOOD" ? "RECEIVED" : item.condition,
        }));

        const historyNonSerialized = processedNonSerialized.map(item => ({
            productId: item.productId,
            productName: item.productName,
            productCode: item.productCode,
            isSerialized: false,
            orderedQuantity: item.orderedQuantity,
            receivedQuantity: item.receivedQuantity,
            damagedQuantity: item.damagedQuantity,
            missingQuantity: item.missingQuantity,
            rejectedQuantity: item.rejectedQuantity,
            serialNumbers: [],
            status: deriveLineStatus({
                assignedQty: item.orderedQuantity,
                receivedQty: item.receivedQuantity,
                damagedQty: item.damagedQuantity,
                missingQty: item.missingQuantity,
                rejectedQty: item.rejectedQuantity,
            }),
        }));

        const allHistoryItems = [...historySerials, ...historyNonSerialized];

        const totalReceived = processedSerials.filter(s => s.condition === "GOOD").length + totalGoodReceived;
        const totalDamaged = processedSerials.filter(s => s.condition === "DAMAGED").length + totalDamagedReceived;
        const totalMissing = processedSerials.filter(s => s.condition === "MISSING").length + totalMissingReceived;
        const totalRejected = totalRejectedReceived;

        let totalAmount = 0;
        for (const item of allHistoryItems) {
            const purchaseItem = purchase.items.find(
                i => i.productId.toString() === item.productId.toString()
            );
            if (purchaseItem) {
                totalAmount += (purchaseItem.purchasePrice || 0) * (item.receivedQuantity || 0);
            }
        }

        // Outcome of THIS receive event only (not the doc's overall
        // progress) - assignedQty is deliberately the sum of everything
        // just processed, so this always resolves to one of the
        // "fully processed" branches (COMPLETED/DAMAGED/MISSING/
        // REJECTED/PARTIAL), matching ReceiveHistory.status's enum.
        const historyStatus = deriveStatus({
            assignedQty: totalReceived + totalDamaged + totalMissing + totalRejected,
            receivedQty: totalReceived,
            damagedQty: totalDamaged,
            missingQty: totalMissing,
            rejectedQty: totalRejected,
        });

        const history = await ReceiveHistory.create([{
            purchaseId: purchase._id,
            purchaseNumber: purchase.purchaseNumber,
            branchId: userBranchId,
            branchName: branch.name || '',
            vendorId: purchase.vendorId?._id || null,
            vendorName: purchase.vendorId?.name || '',
            items: allHistoryItems,
            summary: {
                totalItems: allHistoryItems.length,
                totalReceived,
                totalDamaged,
                totalMissing,
                totalRejected,
                totalAmount,
            },
            receivedAt: new Date(),
            receivedBy: user._id,
            receivedByName: userDetails?.name || user.name || 'Unknown',
            notes: notes || '',
            status: historyStatus,
        }], { session });

        // ✅ Record every deferred stock movement now that this receive
        // event has its own ReceiveHistory _id to use as referenceId.
        for (const movement of [...serialStockMovementsToRecord, ...batchStockMovementsToRecord]) {
            await recordStockMovement({
                type: "PURCHASE_RECEIVE_CENTRAL",
                ...movement,
                referenceType: "ReceiveHistory",
                referenceId: history[0]._id,
                performedBy: user._id,
                performedByName: userDetails?.name || user.name || 'Unknown',
                session,
            });
        }

        // ============================================================
        // ✅ ROLL UP Purchase.overallReceiveStatus ACROSS EVERY BRANCH
        // this purchase assigned stock to - inside the same transaction,
        // so it can never reflect a receive event that gets rolled back.
        // ============================================================
        await recomputeOverallReceiveStatus(purchase._id, session);

        // ============================================================
        // ✅ COMMIT TRANSACTION
        // ============================================================
        await session.commitTransaction();
        session.endSession();

        return successResponse(res, "Items received successfully", {
            summary: {
                totalSerialsReceived: processedSerials.length,
                totalNonSerializedProcessed: processedNonSerialized.length,
                totalItemsProcessed: processedSerials.length + processedNonSerialized.length,
                totalReceived,
                totalDamaged,
                totalMissing,
                totalRejected,
                historyStatus,
            },
            serials: processedSerials,
            nonSerialized: processedNonSerialized,
            historyId: history[0]?._id || null,
        });

    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("Bulk Receive Error:", error);
        return errorResponse(res, error.message || "Failed to receive items", 500);
    }
};
