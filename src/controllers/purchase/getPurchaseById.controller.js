// controllers/purchase/getPurchaseById.controller.js
import mongoose from "mongoose";
import Purchase from "../../models/Purchase.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Inventory from "../../models/Inventory.modal.js";
import PendingReceive from "../../models/PendingReceive.modal.js";
import Batch from "../../models/Batch.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Branch from "../../models/Branch.modal.js";
import PurchaseEditHistory from "../../models/PurchaseEditHistory.modal.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getPurchaseByIdController = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return errorResponse(res, "Purchase ID is required", 400);
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return errorResponse(res, "Invalid purchase ID", 400);
        }

        // ============================================================
        // 1. FETCH PURCHASE
        // ============================================================

        const purchase = await Purchase.findById(id)
            .populate("vendorId", "name phone email gstNumber address")
            .populate("createdBy", "name email")
            .populate("updatedBy", "name email")
            .populate("reviewedBy", "name email")
            .populate("items.productId", "name productCode category isSerialized hsnCode description")
            .populate("paymentDetails.handledBy.userId", "name email")
            .lean();

        if (!purchase) {
            return errorResponse(res, "Purchase not found", 404);
        }

        // ============================================================
        // 2. FETCH PRODUCT SERIALS (Serialized Products)
        // ============================================================
        
        const serials = await ProductSerial.find({
            purchaseId: purchase._id,
        })
            .select("productId serialNumber modelNumber purchasePrice sellingPrice gstApplicable status currentBranchId assignedBranchId createdAt receivedAt soldAt transferredAt description notes mdm images")
            .populate("currentBranchId", "name code")
            .populate("assignedBranchId", "name code")
            .lean();

        // ============================================================
        // 3. FETCH BATCHES (Non-Serialized Products)
        // ============================================================
        
        const batches = await Batch.find({
            purchaseId: purchase._id,
        })
            .select("batchNumber productId purchaseId purchasePrice sellingPrice quantity status notes createdAt")
            .populate("productId", "name productCode")
            .lean();

        // ============================================================
        // 4. FETCH BATCHSTOCK (Branch-specific stock) - Using batchId
        // ============================================================
        
        const batchIds = batches.map((batch) => batch._id);
        let batchStocks = [];

        if (batchIds.length > 0) {
            batchStocks = await BatchStock.find({
                batchId: { $in: batchIds },
            })
                .populate("branchId", "name code")
                .populate("productId", "name productCode")
                .lean();
        }

        // ============================================================
        // 5. FETCH PENDING RECEIVES (SUPER_ADMIN purchases)
        // ============================================================
        
        const pendingReceives = await PendingReceive.find({
            purchaseId: purchase._id,
        })
            .populate("branchId", "name code")
            .populate("items.productId", "name productCode")
            .lean();

        // ============================================================
        // 6. FETCH INVENTORY
        // ============================================================
        
        const productIds = purchase.items.map(item => item.productId._id);
        const inventories = await Inventory.find({
            productId: { $in: productIds },
        })
            .populate("branchId", "name code")
            .lean();

        // ============================================================
        // 6.5 FETCH ITEM-LEVEL BRANCHES (destination branch stamped on
        // each purchase item at create time - authoritative regardless
        // of whether stock/pending-receive rows exist yet). Looked up
        // separately rather than via .populate("items.branchId", ...)
        // on the main query, because PurchaseEditEntryTable.jsx already
        // relies on item.branchId staying a raw ObjectId string
        // (`locationId = item.branchId || null`) - populating it there
        // would silently break that screen's location dropdown.
        // ============================================================

        const itemBranchIds = [...new Set(
            purchase.items.map(item => item.branchId).filter(Boolean).map(String)
        )];
        const itemBranches = itemBranchIds.length
            ? await Branch.find({ _id: { $in: itemBranchIds } })
                .select("name code address phones email")
                .lean()
            : [];
        const branchByItemBranchId = new Map(itemBranches.map(b => [b._id.toString(), b]));

        // ============================================================
        // 7. GROUP DATA
        // ============================================================

        // Each purchase item now represents exactly one physical
        // serialized unit (item.serialNumbers has a single entry), so
        // serials must be matched by their exact serialNumber - not
        // grouped by productId, which would attach every serial of that
        // product (across other items in the same purchase) onto each
        // item alike.
        const serialsBySerialNumber = new Map(
            serials.map(serial => [serial.serialNumber, serial])
        );

        // Group batches by productId
        const batchesByProductId = new Map();
        for (const batch of batches) {
            const productIdStr = batch.productId._id.toString();
            if (!batchesByProductId.has(productIdStr)) {
                batchesByProductId.set(productIdStr, []);
            }
            batchesByProductId.get(productIdStr).push(batch);
        }

        // ✅ Group BatchStock by batchId (not batchNumber)
        const batchStockByBatchId = new Map();
        for (const stock of batchStocks) {
            const batchIdStr = stock.batchId.toString();
            if (!batchStockByBatchId.has(batchIdStr)) {
                batchStockByBatchId.set(batchIdStr, []);
            }
            batchStockByBatchId.get(batchIdStr).push(stock);
        }

        // Group pending receives by productId
        const pendingReceiveByProductId = new Map();
        for (const pr of pendingReceives) {
            for (const item of pr.items) {
                const productIdStr = item.productId._id.toString();
                if (!pendingReceiveByProductId.has(productIdStr)) {
                    pendingReceiveByProductId.set(productIdStr, []);
                }
                pendingReceiveByProductId.get(productIdStr).push({
                    branchId: pr.branchId,
                    orderedQuantity: item.orderedQuantity,
                    receivedQuantity: item.receivedQuantity,
                    damagedQuantity: item.damagedQuantity || 0,
                    rejectedQuantity: item.rejectedQuantity || 0,
                    status: item.status,
                    receiveStatus: pr.status,
                    receivedSerialNumbers: item.receivedSerialNumbers || [],
                });
            }
        }

        // Group inventory by productId
        const inventoryByProductId = new Map();
        for (const inv of inventories) {
            const productIdStr = inv.productId.toString();
            if (!inventoryByProductId.has(productIdStr)) {
                inventoryByProductId.set(productIdStr, []);
            }
            inventoryByProductId.get(productIdStr).push(inv);
        }

        // ============================================================
        // 8. TRANSFORM PURCHASE ITEMS
        // ============================================================
        
        purchase.items = purchase.items.map((item) => {
            const product = item.productId;
            const isSerialized = product?.isSerialized || false;
            const productIdStr = product._id.toString();

            let branchInfo = null;
            let serialDetails = [];
            let batchDetails = [];
            let pendingReceiveInfo = null;
            let inventoryInfo = [];
            let receiveStatus = "PENDING";

            if (isSerialized) {
                // ============================================================
                // SERIALIZED PRODUCT - one item is exactly one physical
                // unit, so look up its own serial by exact serialNumber
                // rather than pulling in every serial of this product
                // from elsewhere in the same purchase.
                // ============================================================

                const itemSerialNumber = item.serialNumbers?.[0]?.serialNumber || null;
                const matchedSerial = itemSerialNumber
                    ? serialsBySerialNumber.get(itemSerialNumber)
                    : null;

                serialDetails = matchedSerial ? [{
                    _id: matchedSerial._id,
                    serialNumber: matchedSerial.serialNumber,
                    modelNumber: matchedSerial.modelNumber,
                    purchasePrice: matchedSerial.purchasePrice,
                    sellingPrice: matchedSerial.sellingPrice,
                    gstApplicable: matchedSerial.gstApplicable,
                    status: matchedSerial.status,
                    description: matchedSerial.description || { main: "", second: "" },
                    notes: matchedSerial.notes || "",
                    mdm: !!matchedSerial.mdm,
                    images: matchedSerial.images || [],
                    currentBranch: matchedSerial.currentBranchId ? {
                        _id: matchedSerial.currentBranchId._id,
                        name: matchedSerial.currentBranchId.name,
                        code: matchedSerial.currentBranchId.code,
                    } : null,
                    assignedBranch: matchedSerial.assignedBranchId ? {
                        _id: matchedSerial.assignedBranchId._id,
                        name: matchedSerial.assignedBranchId.name,
                        code: matchedSerial.assignedBranchId.code,
                    } : null,
                    receivedAt: matchedSerial.receivedAt,
                    soldAt: matchedSerial.soldAt,
                    transferredAt: matchedSerial.transferredAt,
                    createdAt: matchedSerial.createdAt,
                }] : [];

                if (serialDetails.length > 0) {
                    const firstSerial = serialDetails[0];
                    branchInfo = firstSerial.currentBranch || firstSerial.assignedBranch;
                }

                // ASSIGNED = created for a SUPER_ADMIN/CENTRAL purchase,
                // still waiting on the separate bulk-receive flow - every
                // other status means this specific unit already entered
                // real stock at some point.
                receiveStatus = matchedSerial && matchedSerial.status !== "ASSIGNED"
                    ? "RECEIVED"
                    : "PENDING";

            } else {
                // ============================================================
                // NON-SERIALIZED PRODUCT
                // ============================================================
                
                const productBatches = batchesByProductId.get(productIdStr) || [];
                
                // ✅ Build batch details with BatchStock (using batchId)
                batchDetails = productBatches.map(batch => {
                    // ✅ Get BatchStock by batchId
                    const batchStocksForBatch = batchStockByBatchId.get(batch._id.toString()) || [];
                    
                    // ✅ Calculate totals from BatchStock
                    const totalQuantity = batchStocksForBatch.reduce((sum, s) => sum + s.quantity, 0);
                    const totalAvailable = batchStocksForBatch.reduce((sum, s) => sum + s.availableQuantity, 0);
                    const totalSold = batchStocksForBatch.reduce((sum, s) => sum + s.soldQuantity, 0);
                    const totalDamaged = batchStocksForBatch.reduce((sum, s) => sum + s.damagedQuantity, 0);
                    
                    // ✅ Build branch stocks from BatchStock
                    const branchStocks = batchStocksForBatch.map(stock => ({
                        branch: stock.branchId ? {
                            _id: stock.branchId._id,
                            name: stock.branchId.name,
                            code: stock.branchId.code,
                        } : null,
                        quantity: stock.quantity,
                        availableQuantity: stock.availableQuantity,
                        soldQuantity: stock.soldQuantity,
                        damagedQuantity: stock.damagedQuantity,
                        status: stock.status,
                        createdAt: stock.createdAt,
                        updatedAt: stock.updatedAt,
                    }));
                    
                    // ✅ Get branch from first BatchStock
                    if (branchStocks.length > 0 && !branchInfo) {
                        branchInfo = branchStocks[0].branch;
                    }
                    
                    return {
                        _id: batch._id,
                        batchNumber: batch.batchNumber,
                        purchasePrice: batch.purchasePrice,
                        sellingPrice: batch.sellingPrice,
                        status: batch.status,
                        notes: batch.notes,
                        // ✅ Totals from BatchStock
                        totalQuantity: totalQuantity || batch.quantity || 0,
                        totalAvailableQuantity: totalAvailable,
                        totalSoldQuantity: totalSold,
                        totalDamagedQuantity: totalDamaged,
                        // ✅ Branch-wise stocks
                        branchStocks: branchStocks,
                        createdAt: batch.createdAt,
                    };
                });

                // Get pending receive info - scoped to THIS item's own
                // destination branch. A SUPER_ADMIN/CENTRAL purchase can
                // send the same product to several different branches as
                // separate item lines, each with its own PendingReceive
                // document - falling back to "all pending receives for
                // this productId" would attach another item's branch's
                // pending record here instead.
                const allPendingForProduct = pendingReceiveByProductId.get(productIdStr) || [];
                const pendingInfo = item.branchId
                    ? allPendingForProduct.filter(p => p.branchId?._id?.toString() === item.branchId.toString())
                    : allPendingForProduct;
                if (pendingInfo.length > 0) {
                    const firstPending = pendingInfo[0];
                    pendingReceiveInfo = {
                        branch: firstPending.branchId ? {
                            _id: firstPending.branchId._id,
                            name: firstPending.branchId.name,
                            code: firstPending.branchId.code,
                        } : null,
                        orderedQuantity: firstPending.orderedQuantity,
                        receivedQuantity: firstPending.receivedQuantity,
                        damagedQuantity: firstPending.damagedQuantity,
                        rejectedQuantity: firstPending.rejectedQuantity,
                        status: firstPending.status,
                        receiveStatus: firstPending.receiveStatus,
                        receivedSerialNumbers: firstPending.receivedSerialNumbers || [],
                    };
                    
                    if (!branchInfo && pendingReceiveInfo.branch) {
                        branchInfo = pendingReceiveInfo.branch;
                    }
                }

                // Get inventory info
                const productInventories = inventoryByProductId.get(productIdStr) || [];
                inventoryInfo = productInventories.map(inv => ({
                    branch: inv.branchId ? {
                        _id: inv.branchId._id,
                        name: inv.branchId.name,
                        code: inv.branchId.code,
                    } : null,
                    quantity: inv.quantity,
                    availableQuantity: inv.availableQuantity || inv.quantity,
                    status: inv.status || "ACTIVE",
                }));

                // ✅ Determine receive status based on BatchStock existence
                const hasBatchStock = batchDetails.some(b => b.branchStocks.length > 0);
                const hasAvailableStock = batchDetails.some(b => b.totalAvailableQuantity > 0);
                const hasPendingReceive = pendingInfo.length > 0 && pendingInfo.some(p => p.status === "PENDING");
                const isPartiallyReceived = pendingInfo.length > 0 && pendingInfo.some(p => p.status === "PARTIAL");
                const isFullyReceived = pendingInfo.length > 0 && pendingInfo.every(p => p.status === "RECEIVED");
                
                // ✅ Priority: PendingReceive status over BatchStock
                if (isFullyReceived) {
                    receiveStatus = "RECEIVED";
                } else if (isPartiallyReceived) {
                    receiveStatus = "PARTIAL";
                } else if (hasPendingReceive) {
                    receiveStatus = "PENDING";
                } else if (hasBatchStock) {
                    receiveStatus = "RECEIVED"; // Even if stock is sold out
                } else {
                    receiveStatus = "PENDING";
                }
            }

            // Calculate totals for non-serialized
            let totalBatchQuantity = 0;
            let totalAvailableQuantity = 0;
            
            if (!isSerialized) {
                for (const batch of batchDetails) {
                    totalBatchQuantity += batch.totalQuantity || 0;
                    totalAvailableQuantity += batch.totalAvailableQuantity || 0;
                }
            }

            // The branch actually stamped on this item at purchase time
            // is authoritative - always prefer it over branchInfo derived
            // from batch/serial stock state above (which stays null for
            // a still-pending CENTRAL item that has no stock rows yet).
            // item.branchId itself is left untouched (still the raw
            // ObjectId) - only this separate `branch` field is enriched.
            if (item.branchId) {
                const declaredBranch = branchByItemBranchId.get(item.branchId.toString());
                if (declaredBranch) {
                    branchInfo = declaredBranch;
                }
            }

            return {
                ...item,
                isSerialized: isSerialized,
                branch: branchInfo,
                serialDetails: serialDetails,
                batchDetails: batchDetails,
                totalBatchQuantity: totalBatchQuantity,
                totalAvailableQuantity: totalAvailableQuantity,
                pendingReceiveInfo: pendingReceiveInfo,
                inventoryInfo: inventoryInfo,
                receiveStatus: receiveStatus,
            };
        });

        // ============================================================
        // 9. CALCULATE OVERALL RECEIVE STATUS
        // ============================================================
        
        const allItemsReceived = purchase.items.every(item => item.receiveStatus === "RECEIVED");
        const anyItemReceived = purchase.items.some(item => 
            item.receiveStatus === "PARTIAL" || item.receiveStatus === "RECEIVED"
        );
        const anyItemPending = purchase.items.some(item => item.receiveStatus === "PENDING");
        
        let overallReceiveStatus = "PENDING";
        if (allItemsReceived && purchase.items.length > 0) {
            overallReceiveStatus = "RECEIVED";
        } else if (anyItemReceived && !allItemsReceived) {
            overallReceiveStatus = "PARTIAL";
        } else {
            overallReceiveStatus = "PENDING";
        }

        // ============================================================
        // 10. BUILD BATCH SUMMARY
        // ============================================================
        
        const totalBatches = batches.length;
        let totalBatchQuantity = 0;
        let totalAvailableQuantity = 0;
        
        const batchSummaryBatches = batches.map(batch => {
            // ✅ Get BatchStock by batchId
            const batchStocksForBatch = batchStockByBatchId.get(batch._id.toString()) || [];
            
            const totalQty = batchStocksForBatch.reduce((sum, s) => sum + s.quantity, 0);
            const totalAvail = batchStocksForBatch.reduce((sum, s) => sum + s.availableQuantity, 0);
            
            totalBatchQuantity += totalQty || batch.quantity || 0;
            totalAvailableQuantity += totalAvail;
            
            const branchStocks = batchStocksForBatch.map(stock => ({
                branch: stock.branchId ? {
                    _id: stock.branchId._id,
                    name: stock.branchId.name,
                    code: stock.branchId.code,
                } : null,
                quantity: stock.quantity,
                availableQuantity: stock.availableQuantity,
                soldQuantity: stock.soldQuantity,
                damagedQuantity: stock.damagedQuantity,
                status: stock.status,
            }));
            
            return {
                _id: batch._id,
                batchNumber: batch.batchNumber,
                productName: batch.productId?.name || "Unknown",
                productCode: batch.productId?.productCode || "-",
                purchasePrice: batch.purchasePrice,
                sellingPrice: batch.sellingPrice,
                totalQuantity: totalQty || batch.quantity || 0,
                totalAvailableQuantity: totalAvail,
                branchStocks: branchStocks,
                status: batch.status,
                notes: batch.notes,
                createdAt: batch.createdAt,
            };
        });

        // ============================================================
        // 11. EDIT HISTORY (EOD review reads this to see what changed -
        // the edit already applied by the time review happens, so this
        // is the only surviving record of before/after values)
        // ============================================================

        const editHistory = await PurchaseEditHistory.find({ purchaseId: purchase._id })
            .sort({ createdAt: -1 })
            .populate("editedBy", "name email")
            .lean();

        // ============================================================
        // 12. RESPONSE
        // ============================================================

        return successResponse(res, "Purchase retrieved successfully", {
            ...purchase,
            overallReceiveStatus,
            batchSummary: {
                totalBatches,
                totalBatchQuantity,
                totalAvailableQuantity,
                batches: batchSummaryBatches,
            },
            editHistory,
        });
        
    } catch (error) {
        console.error("Get Purchase By ID Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve purchase", 500);
    }
};


