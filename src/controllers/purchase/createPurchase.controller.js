// controllers/purchase/createPurchase.controller.js
import mongoose from "mongoose";
import Purchase from "../../models/Purchase.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Product from "../../models/Product.modal.js";
import Inventory from "../../models/Inventory.modal.js";
import Batch from "../../models/Batch.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import PendingReceive from "../../models/PendingReceive.modal.js";
import Vendor from "../../models/Vendor.modal.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { generatePurchaseInvoicePdf } from "../../services/purchase/generatePurchaseInvoicePdf.js";
import { generateDocumentNumber } from "../../services/documentNumber.service.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ============================================================
// COUNTER SERVICES
// ============================================================

// Atomic counter for batch numbers
const batchCounterSchema = new mongoose.Schema({
    _id: { type: String, required: true }, // Format: "productCode" (global per product, not per branch)
    seq: { type: Number, default: 0 },
});
const BatchCounter = mongoose.model("BatchCounter", batchCounterSchema);

// ============================================================
// COUNTER HELPERS
// ============================================================

// ✅ Get next batch sequence atomically - global per product, not per
// branch, so a product's batch numbers are sequential and unique across
// every branch (e.g. AAP20WCH-B001, B002, ... regardless of which
// branch received them), matching the agreed barcode format.
const getNextBatchSequence = async (productCode, session) => {
    const counter = await BatchCounter.findOneAndUpdate(
        { _id: productCode },
        { $inc: { seq: 1 } },
        {
            new: true,
            upsert: true,
            session,
            returnDocument: 'after',
        }
    );

    return counter.seq;
};

// ============================================================
// BATCH NUMBER GENERATORS
// ============================================================

// ✅ Generate batch number - global per product, no branch code
// embedded, matching the global BatchCounter above.
const generateBatchNumber = (productCode, sequence) => {
    const paddedSeq = String(sequence).padStart(3, '0');
    return `${productCode}-B${paddedSeq}`;
};

const generateBarcode = (batchNumber) => {
    return batchNumber;
};

// ============================================================
// HELPERS
// ============================================================

const calculateNonSerializedTotals = (item) => {
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

// One serialized purchase item now represents exactly one physical
// unit (never a shared array of serials with one common price) - so
// duplicate detection has to span the WHOLE request via the caller's
// seenSerialNumbers Set, not just one item's own array like before.
const validateSingleSerial = async (serialNumber, seenSerialNumbers, session) => {
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

// ============================================================
// MAIN CONTROLLER
// ============================================================

export const createPurchaseController = async (req, res) => {
    const session = await mongoose.startSession();
    
    try {
        session.startTransaction();
        
        const user = req.user;
        const isSuperAdmin = user?.role === "SUPER_ADMIN";
        const isBranchAdmin = user?.role === "BRANCH_ADMIN";
        
        // ============================================================
        // 1. EXTRACT PAYLOAD
        // ============================================================
        
        const {
            vendorId,
            supplierInvoiceNumber = "",
            supplierInvoiceDate = null,
            reference = "",
            purchaseDate = new Date(),
            notes = "",
            invoiceFile = null,
            signatureFile = null,
            roundOff = false,
            paidAmount = 0,
            paymentStatus = "PAID",
            paymentDetails = [],
            items = [],
            status = "COMPLETED",
        } = req.body;
        
        // ============================================================
        // 2. VALIDATE BASIC REQUIRED FIELDS
        // ============================================================
        
        if (!vendorId) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Vendor is required", 400);
        }
        
        if (!items || items.length === 0) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "At least one item is required", 400);
        }

        // ============================================================
        // 2.5 VENDOR VALIDATION + SNAPSHOT
        // ============================================================
        // A vendorId must resolve to a real, active vendor - not just a
        // syntactically valid ObjectId - same principle CLAUDE.md already
        // mandates for branch references. The snapshot freezes the
        // vendor's identity at purchase time so later Vendor edits never
        // rewrite what this purchase says.

        if (!mongoose.Types.ObjectId.isValid(vendorId)) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Invalid vendor ID", 400);
        }

        const vendor = await Vendor.findOne({
            _id: vendorId,
            isDeleted: false,
        }).session(session);

        if (!vendor) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Vendor not found", 404);
        }

        if (!vendor.isActive) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(
                res,
                "This vendor is deactivated and cannot be used for a new purchase",
                400
            );
        }

        const vendorSnapshot = {
            name: vendor.name || "",
            gstNumber: vendor.gstNumber || "",
            phone: vendor.phone || "",
            email: vendor.email || "",
            address: vendor.address || "",
        };

        // ============================================================
        // 3. BRANCH VALIDATION
        // ============================================================
        
        let userBranchId = null;
        let isDirectReceive = false;
        
        if (isBranchAdmin) {
            if (!user.branchId) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(res, "Branch not assigned to user", 400);
            }
            userBranchId = user.branchId;
            isDirectReceive = true;
        }
        
        // ============================================================
        // 4. FETCH BRANCHES FOR BATCH NUMBER GENERATION
        // ============================================================
        
        // ✅ Collect all branch IDs from items
        const branchIds = new Set();
        for (const item of items) {
            let branchId = item.branchId;
            if (isBranchAdmin) {
                branchId = userBranchId;
            }
            if (branchId) {
                branchIds.add(branchId.toString());
            }
        }
        
        // ✅ Resolve every branch as existing AND active - a syntactically
        // valid ObjectId alone is not enough (project-wide rule, shared
        // helper already used by the user-management controllers).
        const branchMap = new Map();
        for (const id of branchIds) {
            const { branch, error } = await resolveActiveBranch(id);
            if (error) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(res, `Branch ${id}: ${error}`, 400);
            }
            branchMap.set(id, branch);
        }
        
        // ============================================================
        // 5. PROCESS EACH ITEM - COLLECT DATA FOR BATCH CREATION
        // ============================================================
        
        const processedItems = [];
        let calculatedTotalAmount = 0;
        const serialRecordsToCreate = [];
        const batchDataToCreate = [];
        const inventoryUpdates = [];
        const pendingReceiveItemsByBranch = new Map();
        // CENTRAL (SUPER_ADMIN) non-serialized items only. A Batch is
        // created up front here - same moment as direct-receive - so a
        // barcode label can be printed and applied to the physical
        // stock before it ships to any branch, never at receive time.
        // Grouped by product+cost-basis (not by item/branch line) so a
        // single purchased lot split across several destination
        // branches as separate item lines (e.g. 60 units to Branch A,
        // 40 to Branch B) becomes ONE Batch with multiple destinations,
        // never one batch per branch. Two lines for the same product at
        // a genuinely different price/GST are correctly treated as two
        // separate lots (two batches) instead.
        const centralBatchGroupsByProduct = new Map();
        // Spans the whole request, not per-item - one item is now one
        // physical serialized unit, so a duplicate serial could appear
        // across two different items just as easily as within one.
        const seenSerialNumbers = new Set();
        
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            
            // Validate product exists
            const product = await Product.findById(item.productId).session(session);
            if (!product) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(res, `Product not found: ${item.productId}`, 404);
            }
            
            // Determine destination branch
            let destinationBranchId = null;
            let branchName = "";
            let branchCode = "";
            
            if (isSuperAdmin) {
                destinationBranchId = item.branchId;
                if (!destinationBranchId) {
                    await session.abortTransaction();
                    session.endSession();
                    return errorResponse(
                        res,
                        `Item ${i + 1}: Branch ID is required for SUPER_ADMIN purchase`,
                        400
                    );
                }
                const branch = branchMap.get(destinationBranchId.toString());
                if (!branch) {
                    await session.abortTransaction();
                    session.endSession();
                    return errorResponse(res, `Destination branch not found: ${destinationBranchId}`, 404);
                }
                branchName = branch.name || "";
                branchCode = branch.code || branch._id.toString().slice(-3).toUpperCase();
            } else if (isBranchAdmin) {
                destinationBranchId = userBranchId;
                const branch = branchMap.get(destinationBranchId.toString());
                branchName = branch?.name || "";
                branchCode = branch?.code || destinationBranchId.toString().slice(-3).toUpperCase();
            }
            
            // Validate purchase price
            const purchasePrice = parseFloat(item.purchasePrice) || 0;
            const sellingPrice = parseFloat(item.sellingPrice) || 0;
            
            if (purchasePrice <= 0) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(res, `Item ${i + 1}: Purchase price must be greater than 0`, 400);
            }
            
            if (sellingPrice < purchasePrice) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(
                    res,
                    `Item ${i + 1}: Selling price cannot be less than purchase price`,
                    400
                );
            }
            
            // ============================================================
            // 6. SERIALIZED PRODUCT PROCESSING
            // ============================================================
            
            if (product.isSerialized) {
                // One serialized item = exactly one physical unit. Every
                // unit can differ in model/price/GST from every other
                // unit of the same product, so these must never be
                // shared across a group - a second unit is a second
                // item entry in the request, never a second entry in a
                // shared serialNumbers[] array.
                const serialNumberRaw = item.serialNumber;
                if (!serialNumberRaw || typeof serialNumberRaw !== "string" || !serialNumberRaw.trim()) {
                    await session.abortTransaction();
                    session.endSession();
                    return errorResponse(
                        res,
                        `Item ${i + 1}: ${product.name} - a serial number is required (one physical unit per item)`,
                        400
                    );
                }

                const modelNumber = (item.modelNumber || "").trim();
                if (!modelNumber) {
                    await session.abortTransaction();
                    session.endSession();
                    return errorResponse(
                        res,
                        `Item ${i + 1}: ${product.name} - a model number is required for each serialized unit`,
                        400
                    );
                }

                // HSN comes from the Product master for serialized items
                // (never a redundant client-supplied value) - so the
                // product itself must actually have one, or the
                // generated invoice would silently show a blank HSN.
                if (!product.hsnCode || !product.hsnCode.trim()) {
                    await session.abortTransaction();
                    session.endSession();
                    return errorResponse(
                        res,
                        `${product.name} has no HSN/SAC code set on the product master - update the product before purchasing`,
                        400
                    );
                }

                const serialNumber = await validateSingleSerial(serialNumberRaw, seenSerialNumbers, session);
                const itemGstApplicable = item.gstApplicable === true;

                // Per-unit description/images - this physical unit's own
                // source of truth (never Product.description/images,
                // which only apply to non-serialized products). Images
                // are already uploaded to S3 by the time the purchase is
                // submitted (see uploadProductSerialStagingImage
                // .controller.js) - only their {url,key,name} references
                // arrive here, never raw file data.
                // description is an object with two independent free-text
                // slots - main (primary) and second (supplementary) - each
                // validated/truncated the same way the single field used to be.
                const itemDescription = {
                    main: typeof item.description?.main === "string"
                        ? item.description.main.trim().slice(0, 1000)
                        : "",
                    second: typeof item.description?.second === "string"
                        ? item.description.second.trim().slice(0, 1000)
                        : "",
                };
                // Separate free-form field from description (see
                // ProductSerial.modal.js) - same validation treatment.
                const itemNotes = typeof item.notes === "string"
                    ? item.notes.trim().slice(0, 1000)
                    : "";
                const rawItemImages = Array.isArray(item.images) ? item.images : [];
                const itemImages = rawItemImages
                    .filter((img) => img && typeof img.url === "string" && typeof img.key === "string" && img.url.trim() && img.key.trim())
                    .map((img) => ({
                        url: img.url.trim(),
                        key: img.key.trim(),
                        name: typeof img.name === "string" ? img.name.trim().slice(0, 200) : "",
                    }));

                // Input GST at purchase time is a real, client-settable
                // value now (most second-hand purchases still have none,
                // but a purchase from a GST-registered dealer legitimately
                // can) - never forced to 0. Distinct from gstApplicable,
                // which only decides whether output GST applies when
                // THIS unit is later sold.
                const itemPurchaseGstPercent = Number(item.purchaseGstPercent) || 0;
                const itemPurchaseGstAmount = itemPurchaseGstPercent > 0
                    ? round2((purchasePrice * itemPurchaseGstPercent) / 100)
                    : 0;
                const totalPrice = purchasePrice + itemPurchaseGstAmount;
                calculatedTotalAmount += totalPrice;

                serialRecordsToCreate.push({
                    productId: product._id,
                    serialNumber,
                    modelNumber,
                    destinationBranchId,
                    isDirectReceive,
                    purchasePrice,
                    sellingPrice,
                    gstApplicable: itemGstApplicable,
                    purchaseGstPercent: itemPurchaseGstPercent,
                    purchaseGstAmount: itemPurchaseGstAmount,
                    // Snapshotted from the Product master at this exact
                    // moment - this unit's own permanent record from now
                    // on, never re-read from Product again.
                    hsnCode: product.hsnCode || "",
                    // This unit's own description/photos - never
                    // Product.description/images (see the field-level
                    // comments on ProductSerial.modal.js).
                    description: itemDescription,
                    images: itemImages,
                    notes: itemNotes,
                });

                const processedItem = {
                    productId: product._id,
                    quantity: 1,
                    serialNumbers: [{ serialNumber }],
                    batches: [],
                    purchasePrice,
                    sellingPrice,
                    totalPrice,
                    gstApplicable: itemGstApplicable,
                    // HSN belongs to the Product master (already
                    // required there for every product) - never trust a
                    // redundant client-supplied value for a serialized
                    // unit, just read it from the product.
                    hsnCode: product.hsnCode || "",
                    purchaseGstPercent: itemPurchaseGstPercent,
                    purchaseGstAmount: itemPurchaseGstAmount,
                    // Always the resolved destination branch - for
                    // SUPER_ADMIN that's the per-item branchId; for
                    // BRANCH_ADMIN it's the caller's own branch. Never
                    // null for either role.
                    branchId: destinationBranchId,
                };

                processedItems.push(processedItem);

                // No PendingReceive entry for serialized units - that
                // collection is explicitly scoped to non-serialized
                // lines only (per its own schema comment). A serialized
                // unit's pending/received state is fully represented by
                // ProductSerial.status (ASSIGNED -> AVAILABLE) alone;
                // adding a PendingReceive row here would create a
                // second, redundant place tracking the same fact.
            }
            
            // ============================================================
            // 7. NON-SERIALIZED PRODUCT PROCESSING
            // ============================================================
            
            else {
                const quantity = parseInt(item.quantity) || 0;
                
                if (quantity <= 0) {
                    await session.abortTransaction();
                    session.endSession();
                    return errorResponse(
                        res,
                        `${product.name} quantity must be greater than 0`,
                        400
                    );
                }
                
                // HSN comes from the Product master, never a
                // client-supplied value - same rule already applied to
                // serialized items. The product itself must actually
                // have one, or the generated invoice would silently
                // show a blank HSN.
                if (!product.hsnCode || !product.hsnCode.trim()) {
                    await session.abortTransaction();
                    session.endSession();
                    return errorResponse(
                        res,
                        `${product.name} has no HSN/SAC code set on the product master - update the product before purchasing`,
                        400
                    );
                }
                const hsnCode = product.hsnCode;

                const gstPercent = parseFloat(item.purchaseGstPercent) || 0;
                const calculations = calculateNonSerializedTotals(item);
                const totalPrice = calculations.totalPrice;
                calculatedTotalAmount += totalPrice;
                
                // ✅ Store data for batch creation (will be created after purchase)
                if (isDirectReceive) {
                    const productCode = product.productCode || product._id.toString().slice(-6);
                    
                    batchDataToCreate.push({
                        productId: product._id,
                        productCode: productCode,
                        branchId: destinationBranchId,
                        purchasePrice,
                        sellingPrice,
                        quantity,
                        gstApplicable: true,
                        purchaseGstPercent: gstPercent,
                    });
                }
                
                // Prepare purchase item
                const itemIndex = processedItems.length;
                const processedItem = {
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
                    // Always the resolved destination branch - never
                    // null for either role (see matching comment on the
                    // serialized branch above).
                    branchId: destinationBranchId,
                };

                processedItems.push(processedItem);

                // Group into a CENTRAL batch (SUPER_ADMIN only) - the
                // actual Batch document and PendingReceive rows are
                // built after purchase.save() below, once every item
                // has been processed and quantities/destinations for
                // the same product+cost-basis are fully known.
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
        
        // ============================================================
        // 7.5 ROUND-OFF (computed server-side - never trust a
        // client-supplied roundOffAmount)
        // ============================================================

        let roundOffAmount = 0;
        if (roundOff) {
            const roundedTotal = Math.round(calculatedTotalAmount);
            roundOffAmount = Math.round((roundedTotal - calculatedTotalAmount) * 100) / 100;
            calculatedTotalAmount = roundedTotal;
        }

        // ============================================================
        // 8. PAYMENT VALIDATION
        // ============================================================

        let finalPaidAmount = 0;
        let finalPendingAmount = 0;
        let finalPaymentStatus = paymentStatus;
        
        if (paymentStatus === "PAID") {
            // If itemized payment records are provided, they must
            // actually sum to the real total - a PAID purchase can't
            // silently record less money than what was actually bought
            // while paymentDetails says otherwise. Not required when
            // paymentDetails is empty (a purchase can be marked PAID
            // without itemized records, e.g. paid in full outside the
            // system before this record was entered).
            if (paymentDetails.length > 0) {
                const totalPaymentDetails = paymentDetails.reduce(
                    (sum, p) => sum + (parseFloat(p.amount) || 0),
                    0
                );
                if (Math.abs(totalPaymentDetails - calculatedTotalAmount) > 0.01) {
                    await session.abortTransaction();
                    session.endSession();
                    return errorResponse(
                        res,
                        `Sum of payment details (${totalPaymentDetails}) does not match the purchase total (${calculatedTotalAmount}) for a PAID purchase`,
                        400
                    );
                }
            }
            finalPaidAmount = calculatedTotalAmount;
            finalPendingAmount = 0;
        } else if (paymentStatus === "PENDING") {
            // Nothing has been paid yet - payment records here would be
            // a direct contradiction (money recorded against a
            // purchase marked as having none paid).
            if (paymentDetails.length > 0) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(
                    res,
                    "A PENDING purchase cannot include payment details - use PARTIAL or PAID instead",
                    400
                );
            }
            finalPaidAmount = 0;
            finalPendingAmount = calculatedTotalAmount;
        } else if (paymentStatus === "PARTIAL") {
            finalPaidAmount = parseFloat(paidAmount) || 0;
            if (finalPaidAmount <= 0 || finalPaidAmount >= calculatedTotalAmount) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(
                    res,
                    "PARTIAL payment requires paidAmount between 0 and totalAmount",
                    400
                );
            }
            finalPendingAmount = Math.round((calculatedTotalAmount - finalPaidAmount) * 100) / 100;
            
            const totalPaymentDetails = paymentDetails.reduce(
                (sum, p) => sum + (parseFloat(p.amount) || 0),
                0
            );
            if (Math.abs(totalPaymentDetails - finalPaidAmount) > 0.01) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(
                    res,
                    `Sum of payment details (${totalPaymentDetails}) does not match paidAmount (${finalPaidAmount})`,
                    400
                );
            }
        } else {
            finalPaymentStatus = "PAID";
            finalPaidAmount = calculatedTotalAmount;
            finalPendingAmount = 0;
        }
        
        // ============================================================
        // 9. GENERATE PURCHASE NUMBER (Atomic) - prefix read fresh from
        // Global Settings so a Super Admin's prefix change takes effect
        // on the very next purchase without touching anything already
        // generated.
        // ============================================================

        const gstConfigForNumber = await getOrCreateGstConfig({ session });
        const purchaseNumber = await generateDocumentNumber("purchase", gstConfigForNumber.documentPrefixes.purchase, { session });
        
        // ============================================================
        // 10. CREATE PURCHASE
        // ============================================================
        
        const purchase = new Purchase({
            purchaseNumber,
            vendorId,
            vendorSnapshot,
            branchId: isSuperAdmin ? null : userBranchId,
            poType: isSuperAdmin ? "CENTRAL" : "BRANCH",
            supplierInvoiceNumber,
            supplierInvoiceDate: supplierInvoiceDate ? new Date(supplierInvoiceDate) : null,
            systemInvoiceFile: null,
            purchaseDate: new Date(purchaseDate),
            reference: reference || "",
            roundOff: roundOff || false,
            roundOffAmount,
            paymentStatus: finalPaymentStatus,
            paidAmount: finalPaidAmount,
            pendingAmount: finalPendingAmount,
            paymentDetails: paymentDetails.map(p => ({
                amount: parseFloat(p.amount) || 0,
                paymentDate: p.paymentDate ? new Date(p.paymentDate) : new Date(),
                paymentMethod: p.paymentMethod || "CASH",
                notes: p.notes || "",
                attachment: p.attachment || null,
                // Never trust a client-supplied handler - always the
                // authenticated user recording this payment right now.
                handledBy: {
                    userId: user._id,
                    name: user.name || "",
                    role: user.role || "",
                },
            })),
            invoiceFile: invoiceFile || null,
            signatureFile: signatureFile || null,
            status: status || "COMPLETED",
            items: processedItems,
            totalAmount: calculatedTotalAmount,
            notes: notes || "",
            createdBy: user._id,
            updatedBy: user._id,
        });
        
        await purchase.save({ session });
        
        // ============================================================
        // 11. CREATE BATCHES AND BATCHSTOCK (BRANCH_ADMIN only)
        // ============================================================
        
        const createdBatches = [];
        
        if (isDirectReceive && batchDataToCreate.length > 0) {
            for (const batchData of batchDataToCreate) {
                // ✅ Get next sequence number atomically - global per
                // product, not per branch
                const sequence = await getNextBatchSequence(
                    batchData.productCode,
                    session
                );

                // ✅ Generate batch number - global per product, no
                // branch code embedded
                const batchNumber = generateBatchNumber(
                    batchData.productCode,
                    sequence
                );

                // ✅ Create Batch with purchaseId
                const batch = new Batch({
                    batchNumber,
                    branchId: batchData.branchId,
                    productId: batchData.productId,
                    purchaseId: purchase._id,
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

                // ✅ Create BatchStock
                const barcode = generateBarcode(batchNumber);
                const batchStock = new BatchStock({
                    batchId: batch._id,
                    productId: batchData.productId,
                    branchId: batchData.branchId,
                    batchNumber: batchNumber,
                    barcode: barcode,
                    productCode: batchData.productCode,
                    purchaseId: purchase._id,
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

                // ✅ Record the stock movement caused by this batch
                // entering available stock - same transaction, per the
                // current-state/historical-record split.
                await recordStockMovement({
                    type: "PURCHASE_RECEIVE_DIRECT",
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
                    batchStockId: batchStock._id,
                    batchNumber: batchNumber,
                    quantity: batchData.quantity,
                    purchasePrice: batchData.purchasePrice,
                    sellingPrice: batchData.sellingPrice,
                });
                
                // ✅ Update Inventory
                inventoryUpdates.push({
                    productId: batchData.productId,
                    branchId: batchData.branchId,
                    quantity: batchData.quantity,
                });
            }
        }
        
        // ============================================================
        // 12. UPDATE PURCHASE ITEMS WITH BATCH INFO
        // ============================================================
        
        if (isDirectReceive && createdBatches.length > 0) {
            for (let i = 0; i < purchase.items.length; i++) {
                const item = purchase.items[i];
                // ✅ Match by productId AND branchId - item.branchId is
                // now always the resolved destination branch for both
                // roles, no role-specific fallback needed here anymore.
                const matchingBatch = createdBatches.find(
                    b => b.productId.toString() === item.productId.toString() &&
                         b.branchId.toString() === item.branchId?.toString()
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
            await purchase.save({ session });
        }

        // ============================================================
        // 12.5 CREATE BATCHES FOR CENTRAL (SUPER_ADMIN) NON-SERIALIZED
        // ITEMS - created up front, same moment as direct-receive, so a
        // barcode label can be printed and applied to the physical
        // stock before it ships to any branch. One Batch per distinct
        // product+cost-basis group (see centralBatchGroupsByProduct
        // above) - a single purchased lot split across several
        // destination branches becomes ONE batch with several
        // destinations, never one batch per branch. BatchStock (the
        // per-branch sellable count) is deliberately NOT created here -
        // it's only created later, when each branch actually confirms
        // physical receipt via bulkReceiveController.
        // ============================================================

        const centralBatchesByGroupKey = new Map();

        if (isSuperAdmin && centralBatchGroupsByProduct.size > 0) {
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

                centralBatchesByGroupKey.set(groupKey, {
                    batchId: batch._id,
                    batchNumber,
                });
            }

            // Attach this item line's own slice of the batch, and build
            // the pending-receive-by-branch data with the real batchId
            // now available (both need the batch to exist first).
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
                            branchCode: dest.branchCode,
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

            await purchase.save({ session });
        }

        // ============================================================
        // 13. UPDATE INVENTORY (BRANCH_ADMIN only)
        // ============================================================
        
        if (isDirectReceive && inventoryUpdates.length > 0) {
            for (const update of inventoryUpdates) {
                const inventory = await Inventory.findOne({
                    branchId: update.branchId,
                    productId: update.productId,
                }).session(session);
                
                if (inventory) {
                    inventory.quantity += update.quantity;
                    await inventory.save({ session });
                } else {
                    await Inventory.create([{
                        branchId: update.branchId,
                        productId: update.productId,
                        quantity: update.quantity,
                    }], { session });
                }
            }
        }
        
        // ============================================================
        // 14. CREATE PRODUCT SERIAL RECORDS
        // ============================================================
        
        const createdSerialRecords = [];
        for (const serialData of serialRecordsToCreate) {
            const serialDoc = new ProductSerial({
                productId: serialData.productId,
                purchaseId: purchase._id,
                serialNumber: serialData.serialNumber,
                modelNumber: serialData.modelNumber,
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
            });
            createdSerialRecords.push({ doc: serialDoc, serialData });
        }

        if (createdSerialRecords.length > 0) {
            const insertedSerials = await ProductSerial.insertMany(
                createdSerialRecords.map(r => r.doc),
                { session }
            );

            // ✅ Record a stock movement for every serial that entered
            // AVAILABLE stock directly (BRANCH_ADMIN purchase). A
            // SUPER_ADMIN/CENTRAL purchase's serials stay ASSIGNED
            // (pending) until the separate, later receive flow - no
            // movement yet, since no stock has actually become
            // available at any branch.
            for (let i = 0; i < insertedSerials.length; i++) {
                const inserted = insertedSerials[i];
                const { serialData } = createdSerialRecords[i];
                if (inserted.status === "AVAILABLE") {
                    await recordStockMovement({
                        type: "PURCHASE_RECEIVE_DIRECT",
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
        
        // ============================================================
        // 15. CREATE PENDING RECEIVES (SUPER_ADMIN only)
        // ============================================================
        
        if (isSuperAdmin && pendingReceiveItemsByBranch.size > 0) {
            for (const pendingData of pendingReceiveItemsByBranch.values()) {
                if (pendingData.items.length > 0) {
                    await PendingReceive.create([{
                        purchaseId: purchase._id,
                        branchId: pendingData.branchId,
                        items: pendingData.items.map(item => ({
                            productId: item.productId,
                            productName: item.productName,
                            batchId: item.batchId || null,
                            batchNumber: item.batchNumber || "",
                            orderedQuantity: item.orderedQuantity,
                            receivedQuantity: 0,
                            damagedQuantity: 0,
                            rejectedQuantity: 0,
                            status: "PENDING",
                        })),
                        status: "PENDING",
                        createdBy: user._id,
                        notes: `Pending receive for branch ${pendingData.branchName}`,
                    }], { session });
                }
            }
        }
        
        // ============================================================
        // 16. COMMIT TRANSACTION
        // ============================================================
        
        await session.commitTransaction();
        session.endSession();
        
        // ============================================================
        // 17. GENERATE SYSTEM INVOICE PDF + UPLOAD TO S3 (after the
        // transaction commits - PDF/S3 failure must never fail or roll
        // back the purchase itself; the stock movement and financial
        // record are what matter most)
        // ============================================================

        let systemInvoiceUrl = null;
        try {
            const populatedPurchase = await Purchase.findById(purchase._id)
                .populate("vendorId", "name phone email address")
                .populate("items.productId", "name productCode isSerialized hsnCode description")
                .populate("createdBy", "name email")
                // Branch is only set for a direct-receive (BRANCH_ADMIN)
                // purchase - a CENTRAL purchase has no single physical
                // location to print, so this stays null there and the
                // PDF generator falls back to a generic header.
                .populate("branchId", "name address phones email");

            // Model number lives on ProductSerial, not on Purchase.items
            // itself - serialRecordsToCreate (built earlier in this same
            // request, already in scope) carries the exact per-unit
            // modelNumber the customer chose. Attaching it here is a
            // display-only, in-memory enrichment of the object handed to
            // the PDF renderer - it does not touch the persisted
            // Purchase document, its schema, or any calculation.
            const modelNumberBySerial = new Map(
                serialRecordsToCreate.map((s) => [s.serialNumber, s.modelNumber])
            );
            const purchaseForInvoice = populatedPurchase.toObject();
            purchaseForInvoice.items = purchaseForInvoice.items.map((item) => {
                const serialNumber = item.serialNumbers?.[0]?.serialNumber;
                return serialNumber && modelNumberBySerial.has(serialNumber)
                    ? { ...item, modelNumber: modelNumberBySerial.get(serialNumber) }
                    : item;
            });

            // Never overwrite an existing invoice - this is a brand new
            // purchase so systemInvoiceFile is always null here, but the
            // guard inside the service is the real enforcement.
            const { url } = await generatePurchaseInvoicePdf(
                purchaseForInvoice
            );

            systemInvoiceUrl = url;

            purchase.systemInvoiceFile = systemInvoiceUrl;
            await purchase.save();

        } catch (pdfError) {
            console.error("System Invoice PDF/S3 Error:", pdfError);
        }
        
        // ============================================================
        // 18. POPULATE RESPONSE
        // ============================================================
        
        const finalPurchase = await Purchase.findById(purchase._id)
            .populate("vendorId", "name email phone address")
            .populate("createdBy", "name email")
            .populate("items.productId", "name productCode isSerialized category hsnCode");
        
        let message = "Purchase created successfully.";
        if (isSuperAdmin) {
            const branchCount = pendingReceiveItemsByBranch.size;
            const centralBatchCount = centralBatchesByGroupKey.size;
            const batchNote = centralBatchCount > 0 ? ` ${centralBatchCount} batch(es) created and ready for labeling.` : "";
            message = systemInvoiceUrl
                ? `Purchase created successfully. System invoice generated. Items assigned to ${branchCount} branch(es).${batchNote}`
                : `Purchase created successfully. Items assigned to ${branchCount} branch(es). System invoice generation failed.${batchNote}`;
        } else {
            const batchCount = createdBatches.length;
            message = systemInvoiceUrl
                ? `Purchase created successfully. ${batchCount} batch(es) created. System invoice generated.`
                : `Purchase created successfully. ${batchCount} batch(es) created. System invoice generation failed.`;
        }

        return successResponse(
            res,
            message,
            {
                purchase: finalPurchase,
                vendorInvoice: finalPurchase.invoiceFile ? {
                    fileName: finalPurchase.invoiceFile,
                    url: finalPurchase.invoiceFile,
                } : null,
                systemInvoice: systemInvoiceUrl ? {
                    url: systemInvoiceUrl,
                } : null,
                supplierInvoiceNumber: finalPurchase.supplierInvoiceNumber || null,
                ...(isDirectReceive && createdBatches.length > 0 && {
                    batches: createdBatches.map(b => ({
                        batchNumber: b.batchNumber,
                        productId: b.productId,
                        branchId: b.branchId,
                        quantity: b.quantity,
                        purchasePrice: b.purchasePrice,
                        sellingPrice: b.sellingPrice,
                    })),
                }),
                // CENTRAL batches - no BatchStock exists yet (nothing is
                // physically at any branch), but the batch identity and
                // barcode already exist, so labels can be printed right
                // now, before the goods ship out to their destinations.
                ...(isSuperAdmin && centralBatchesByGroupKey.size > 0 && {
                    batches: [...centralBatchGroupsByProduct.entries()].map(([groupKey, group]) => ({
                        batchNumber: centralBatchesByGroupKey.get(groupKey).batchNumber,
                        batchId: centralBatchesByGroupKey.get(groupKey).batchId,
                        productId: group.productId,
                        productName: group.productName,
                        totalQuantity: group.totalQuantity,
                        purchasePrice: group.purchasePrice,
                        sellingPrice: group.sellingPrice,
                        destinations: group.destinations.map(d => ({
                            branchId: d.branchId,
                            branchName: d.branchName,
                            quantity: d.quantity,
                        })),
                    })),
                }),
            },
            201
        );
        
    } catch (error) {
        if (session.inTransaction()) {
            await session.abortTransaction();
        }
        session.endSession();
        
        console.error("Create Purchase Error:", error);
        
        if (error.code === 11000) {
            return errorResponse(res, "Duplicate purchase number or serial number", 400);
        }
        
        if (error.message.includes("already exist")) {
            return errorResponse(res, error.message, 409);
        }
        
        return errorResponse(res, error.message || "Error creating purchase", 500);
    }
};


