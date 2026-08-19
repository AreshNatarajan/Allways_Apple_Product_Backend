// controllers/purchase/createPurchase.controller.js
import mongoose from "mongoose";
import Purchase from "../../models/Purchase.modal.js";
import Vendor from "../../models/Vendor.modal.js";
import { generatePurchaseInvoicePdf } from "../../services/purchase/generatePurchaseInvoicePdf.js";
import { generateDocumentNumber } from "../../services/documentNumber.service.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import {
    resolveItemBranches,
    prepareItems,
    applyRoundOff,
    commitItemInventory,
} from "../../services/purchase/purchaseItemProcessor.service.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

// ============================================================
// MAIN CONTROLLER
// ============================================================
// Item validation/processing and inventory creation (batches,
// ProductSerial, PendingReceive, stock movements) live in
// purchaseItemProcessor.service.js - shared with
// updatePurchase.controller.js's "add new items" append path, so the
// two flows can never drift apart on GST/batch-numbering/stock math.

export const createPurchaseController = async (req, res) => {
    const session = await mongoose.startSession();

    try {
        session.startTransaction();

        const user = req.user;
        const isSuperAdmin = user?.role === "SUPER_ADMIN";
        // Everyone who isn't SUPER_ADMIN (BRANCH_ADMIN and STAFF alike)
        // follows the same direct-branch-purchase flow: their own
        // branchId, stock enters immediately, no PendingReceive step -
        // the CENTRAL/pending-receive flow below is SUPER_ADMIN-only.
        const isBranchFlow = !isSuperAdmin;

        // ============================================================
        // 1. EXTRACT PAYLOAD
        // ============================================================

        const {
            vendorId,
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

        if (isBranchFlow) {
            if (!user.branchId) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(res, "Branch not assigned to user", 400);
            }
            userBranchId = user.branchId;
            isDirectReceive = true;
        }

        // ============================================================
        // 4. RESOLVE DESTINATION BRANCHES (existing AND active)
        // ============================================================

        const { branchMap, error: branchError } = await resolveItemBranches(items, { isBranchFlow, userBranchId });
        if (branchError) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, branchError, 400);
        }

        // ============================================================
        // 5-7. VALIDATE + PROCESS EVERY ITEM (serialized/non-serialized)
        // ============================================================

        const phase1 = await prepareItems({
            items,
            isSuperAdmin,
            isBranchFlow,
            isDirectReceive,
            userBranchId,
            branchMap,
            session,
        });

        if (phase1.error) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, phase1.error, phase1.error.includes("not found") ? 404 : 400);
        }

        const { processedItems, serialRecordsToCreate, batchDataToCreate, centralBatchGroupsByProduct } = phase1;
        let calculatedTotalAmount = phase1.calculatedTotalAmount;

        // ============================================================
        // 7.5 ROUND-OFF (computed server-side - never trust a
        // client-supplied roundOffAmount)
        // ============================================================

        const { totalAmount: roundedTotalAmount, roundOffAmount } = applyRoundOff(calculatedTotalAmount, roundOff);
        calculatedTotalAmount = roundedTotalAmount;

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
        // 11-15. CREATE ACTUAL INVENTORY (batches/BatchStock/Inventory/
        // ProductSerial/PendingReceive/StockMovement) now that
        // purchase._id exists, and attach batch info onto the matching
        // purchase.items entries.
        // ============================================================

        const { createdBatches, centralBatchesByGroupKey } = await commitItemInventory({
            purchase,
            phase1,
            isSuperAdmin,
            isDirectReceive,
            purchaseNumber,
            user,
            session,
        });

        if ((isDirectReceive && createdBatches.length > 0) || (isSuperAdmin && centralBatchGroupsByProduct.size > 0)) {
            await purchase.save({ session });
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
            const branchCount = new Set((centralBatchGroupsByProduct.size > 0
                ? [...centralBatchGroupsByProduct.values()].flatMap(g => g.destinations.map(d => d.branchId.toString()))
                : [])).size;
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
