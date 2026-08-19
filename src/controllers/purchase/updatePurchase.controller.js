// controllers/purchase/updatePurchase.controller.js
import mongoose from "mongoose";
import Purchase from "../../models/Purchase.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Vendor from "../../models/Vendor.modal.js";
import PurchaseEditHistory from "../../models/PurchaseEditHistory.modal.js";
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
// Purchase Edit. Vendor/date/reference/notes/payment/invoice are
// freely editable; existing items are append-only (description/notes
// on an existing serialized unit can be corrected, but the unit/
// product/price/serial itself never changes - see the per-serial
// cascade below). New items CAN be appended (both serialized and
// non-serialized) via purchaseItemProcessor.service.js - the exact
// same inventory-creation code createPurchase.controller.js uses, so
// a missed item added later creates real Batch/BatchStock/
// ProductSerial/StockMovement records the same way it would have if
// it had been included from the start. branchId/poType stay frozen at
// the model level (PURCHASE_FROZEN_FIELDS) - new items always follow
// the SAME distribution model (CENTRAL/BRANCH) the purchase already
// used, never re-derived from the editing user's own role. Applies
// immediately (no pending-approval gate) - the safety net is EOD
// review, not a save-time block: every edit here resets processStatus
// back to PENDING_REVIEW (unless the editor is already SUPER_ADMIN,
// who needs no one to review them), and every edit is logged to
// PurchaseEditHistory so that review has something concrete to look at.
// ============================================================

const buildValidationError = (message) => {
    const err = new Error(message);
    err.isValidation = true;
    return err;
};

export const updatePurchaseController = async (req, res) => {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const { id } = req.params;
        const user = req.user;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Invalid purchase ID", 400);
        }

        const purchase = await Purchase.findOne({ _id: id, isDeleted: false }).session(session);

        if (!purchase) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Purchase not found", 404);
        }

        if (purchase.status === "CANCELLED") {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Cannot edit a cancelled purchase", 400);
        }

        const {
            vendorId,
            purchaseDate,
            reference,
            notes,
            invoiceFile,
            paymentStatus,
            paidAmount,
            paymentDetails,
            items, // [{ productSerialId, description: { main, second }, notes }]
        } = req.body;

        const changes = [];

        // ============================================================
        // VENDOR
        // ============================================================
        if (vendorId && String(vendorId) !== String(purchase.vendorId)) {
            if (!mongoose.Types.ObjectId.isValid(vendorId)) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(res, "Invalid vendor ID", 400);
            }

            const vendor = await Vendor.findOne({ _id: vendorId, isDeleted: false }).session(session);

            if (!vendor) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(res, "Vendor not found", 404);
            }

            if (!vendor.isActive) {
                await session.abortTransaction();
                session.endSession();
                return errorResponse(res, "This vendor is deactivated and cannot be used for this purchase", 400);
            }

            changes.push({
                field: "vendorId",
                label: "Vendor",
                oldValue: purchase.vendorSnapshot?.name || String(purchase.vendorId),
                newValue: vendor.name,
            });

            purchase.vendorId = vendor._id;
            purchase.vendorSnapshot = {
                name: vendor.name || "",
                gstNumber: vendor.gstNumber || "",
                phone: vendor.phone || "",
                email: vendor.email || "",
                address: vendor.address || "",
            };
        }

        // ============================================================
        // PURCHASE DATE
        // ============================================================
        if (purchaseDate) {
            const newDate = new Date(purchaseDate);
            if (!Number.isNaN(newDate.getTime()) && newDate.getTime() !== new Date(purchase.purchaseDate).getTime()) {
                changes.push({
                    field: "purchaseDate",
                    label: "Purchase Date",
                    oldValue: purchase.purchaseDate,
                    newValue: newDate,
                });
                purchase.purchaseDate = newDate;
            }
        }

        // ============================================================
        // REFERENCE
        // ============================================================
        if (reference !== undefined && reference.trim() !== (purchase.reference || "")) {
            changes.push({
                field: "reference",
                label: "Reference",
                oldValue: purchase.reference || "",
                newValue: reference.trim(),
            });
            purchase.reference = reference.trim();
        }

        // ============================================================
        // NOTES
        // ============================================================
        if (notes !== undefined && notes !== (purchase.notes || "")) {
            changes.push({
                field: "notes",
                label: "Notes",
                oldValue: purchase.notes || "",
                newValue: notes,
            });
            purchase.notes = notes;
        }

        // ============================================================
        // VENDOR INVOICE FILE - never frozen, just an attachment.
        // ============================================================
        if (invoiceFile !== undefined && invoiceFile !== purchase.invoiceFile) {
            changes.push({
                field: "invoiceFile",
                label: "Vendor Invoice",
                oldValue: purchase.invoiceFile ? "Uploaded" : "—",
                newValue: invoiceFile ? "Uploaded" : "—",
            });
            purchase.invoiceFile = invoiceFile;
        }

        // ============================================================
        // NEW ITEMS - append-only. Existing purchase.items entries are
        // never touched here, only pushed to - every already-existing
        // physical unit/batch this purchase already created stays
        // exactly as it was. Must run before the payment section below,
        // since it updates purchase.totalAmount that section validates
        // against.
        // ============================================================
        const newItems = req.body.newItems; // { serialized: [...], nonSerialized: [...] }
        const newSerialized = newItems?.serialized || [];
        const newNonSerialized = newItems?.nonSerialized || [];

        if (newSerialized.length + newNonSerialized.length > 0) {
            if (!purchase.poType) {
                throw buildValidationError(
                    "This purchase predates the branch/CENTRAL purchase type field - new items can't be added to it."
                );
            }

            const isSuperAdmin = purchase.poType === "CENTRAL";
            const isBranchFlow = !isSuperAdmin;
            const isDirectReceive = purchase.poType === "BRANCH";
            const userBranchId = purchase.branchId;

            const rawNewItems = [...newSerialized, ...newNonSerialized];

            const { branchMap, error: branchError } = await resolveItemBranches(rawNewItems, { isBranchFlow, userBranchId });
            if (branchError) {
                throw buildValidationError(branchError);
            }

            // Every serial number already used ANYWHERE in this
            // purchase must be in the duplicate-check set too, not just
            // across the newly appended items.
            const seenSerialNumbers = new Set(
                purchase.items
                    .flatMap((it) => it.serialNumbers || [])
                    .map((s) => s.serialNumber?.toUpperCase())
                    .filter(Boolean)
            );

            const phase1 = await prepareItems({
                items: rawNewItems,
                isSuperAdmin,
                isBranchFlow,
                isDirectReceive,
                userBranchId,
                branchMap,
                session,
                seenSerialNumbers,
                itemIndexOffset: purchase.items.length,
            });

            if (phase1.error) {
                throw buildValidationError(phase1.error);
            }

            const existingTotal = purchase.totalAmount;
            const existingRoundOffAmount = purchase.roundOffAmount || 0;
            const totalBeforeRoundOff = purchase.roundOff ? existingTotal - existingRoundOffAmount : existingTotal;
            const newTotalBeforeRoundOff = totalBeforeRoundOff + phase1.calculatedTotalAmount;
            const { totalAmount: newTotalAmount, roundOffAmount: newRoundOffAmount } = applyRoundOff(newTotalBeforeRoundOff, purchase.roundOff);

            const previousItemCount = purchase.items.length;
            purchase.items.push(...phase1.processedItems);
            purchase.totalAmount = newTotalAmount;
            purchase.roundOffAmount = newRoundOffAmount;

            await commitItemInventory({
                purchase,
                phase1,
                isSuperAdmin,
                isDirectReceive,
                purchaseNumber: purchase.purchaseNumber,
                user,
                session,
            });

            changes.push({
                field: "items",
                label: "Items",
                oldValue: `${previousItemCount} item(s)`,
                newValue: `${purchase.items.length} item(s) (+${phase1.processedItems.length} added)`,
            });
        }

        // ============================================================
        // PAYMENT DETAILS / STATUS - same validation rules as
        // createPurchase.controller.js, replayed against the purchase's
        // own frozen totalAmount (never a client-supplied total).
        // ============================================================
        if (paymentDetails !== undefined) {
            const totalAmount = purchase.totalAmount;
            const finalPaymentStatus = paymentStatus || purchase.paymentStatus;
            let finalPaidAmount = 0;
            let finalPendingAmount = 0;

            const cleanedPayments = (paymentDetails || []).map((p) => ({
                amount: parseFloat(p.amount) || 0,
                paymentDate: p.paymentDate ? new Date(p.paymentDate) : new Date(),
                paymentMethod: p.paymentMethod || "CASH",
                notes: p.notes || "",
                attachment: p.attachment || null,
                handledBy: {
                    userId: user._id,
                    name: user.name || "",
                    role: user.role || "",
                },
            }));

            if (finalPaymentStatus === "PAID") {
                if (cleanedPayments.length > 0) {
                    const sum = cleanedPayments.reduce((s, p) => s + p.amount, 0);
                    if (Math.abs(sum - totalAmount) > 0.01) {
                        throw buildValidationError(
                            `Sum of payment details (${sum}) does not match the purchase total (${totalAmount}) for a PAID purchase`
                        );
                    }
                }
                finalPaidAmount = totalAmount;
                finalPendingAmount = 0;
            } else if (finalPaymentStatus === "PENDING") {
                if (cleanedPayments.length > 0) {
                    throw buildValidationError(
                        "A PENDING purchase cannot include payment details - use PARTIAL or PAID instead"
                    );
                }
                finalPaidAmount = 0;
                finalPendingAmount = totalAmount;
            } else if (finalPaymentStatus === "PARTIAL") {
                finalPaidAmount = parseFloat(paidAmount) || 0;
                if (finalPaidAmount <= 0 || finalPaidAmount >= totalAmount) {
                    throw buildValidationError(
                        "PARTIAL payment requires paidAmount between 0 and totalAmount"
                    );
                }
                finalPendingAmount = Math.round((totalAmount - finalPaidAmount) * 100) / 100;

                const sum = cleanedPayments.reduce((s, p) => s + p.amount, 0);
                if (Math.abs(sum - finalPaidAmount) > 0.01) {
                    throw buildValidationError(
                        `Sum of payment details (${sum}) does not match paidAmount (${finalPaidAmount})`
                    );
                }
            } else {
                throw buildValidationError("paymentStatus must be PAID, PENDING, or PARTIAL");
            }

            const summarize = (list) => (list || []).map((p) => ({
                amount: p.amount,
                paymentMethod: p.paymentMethod,
                notes: p.notes || "",
            }));
            const paymentsChanged = JSON.stringify(summarize(cleanedPayments)) !== JSON.stringify(summarize(purchase.paymentDetails));

            if (paymentsChanged || finalPaymentStatus !== purchase.paymentStatus) {
                changes.push({
                    field: "paymentDetails",
                    label: "Payment Details",
                    oldValue: { paymentStatus: purchase.paymentStatus, paidAmount: purchase.paidAmount, pendingAmount: purchase.pendingAmount },
                    newValue: { paymentStatus: finalPaymentStatus, paidAmount: finalPaidAmount, pendingAmount: finalPendingAmount },
                });
            }

            purchase.paymentStatus = finalPaymentStatus;
            purchase.paidAmount = finalPaidAmount;
            purchase.pendingAmount = finalPendingAmount;
            purchase.paymentDetails = cleanedPayments;
        }

        // ============================================================
        // PER-SERIAL DESCRIPTION / NOTES CASCADE
        // ============================================================
        // Purchase.items[] itself is frozen and has no description/
        // notes fields at all - these live on ProductSerial, so editing
        // them never touches the Purchase document's own frozen
        // fields. productSerialId must belong to THIS purchase - never
        // trust a client-supplied id to update an arbitrary serial.
        // ============================================================
        if (Array.isArray(items) && items.length > 0) {
            for (const itemEdit of items) {
                const { productSerialId, description, notes: serialNotes, images, mdm } = itemEdit || {};
                if (!productSerialId || !mongoose.Types.ObjectId.isValid(productSerialId)) continue;

                const serial = await ProductSerial.findOne({
                    _id: productSerialId,
                    purchaseId: purchase._id,
                    isDeleted: false,
                }).session(session);

                if (!serial) continue;

                const newMain = description?.main ?? serial.description?.main ?? "";
                const newSecond = description?.second ?? serial.description?.second ?? "";
                const newNotes = serialNotes ?? serial.notes ?? "";
                const newMdm = mdm ?? serial.mdm ?? false;
                const rawNewImages = Array.isArray(images) ? images : null;
                const newImages = rawNewImages
                    ? rawNewImages
                        .filter((img) => img && typeof img.url === "string" && typeof img.key === "string" && img.url.trim() && img.key.trim())
                        .map((img) => ({
                            url: img.url.trim(),
                            key: img.key.trim(),
                            name: typeof img.name === "string" ? img.name.trim().slice(0, 200) : "",
                        }))
                    : (serial.images || []);

                const descChanged = newMain !== (serial.description?.main || "") || newSecond !== (serial.description?.second || "");
                const notesChanged = newNotes !== (serial.notes || "");
                const mdmChanged = !!newMdm !== !!serial.mdm;
                const imagesChanged = rawNewImages !== null && JSON.stringify(newImages.map(i => i.key)) !== JSON.stringify((serial.images || []).map(i => i.key));

                if (descChanged) {
                    changes.push({
                        field: `item:${serial.serialNumber}:description`,
                        label: `Description (${serial.serialNumber})`,
                        oldValue: serial.description,
                        newValue: { main: newMain, second: newSecond },
                    });
                    serial.description = { main: newMain, second: newSecond };
                }

                if (notesChanged) {
                    changes.push({
                        field: `item:${serial.serialNumber}:notes`,
                        label: `Notes (${serial.serialNumber})`,
                        oldValue: serial.notes || "",
                        newValue: newNotes,
                    });
                    serial.notes = newNotes;
                }

                if (mdmChanged) {
                    changes.push({
                        field: `item:${serial.serialNumber}:mdm`,
                        label: `MDM (${serial.serialNumber})`,
                        oldValue: !!serial.mdm ? "Yes" : "No",
                        newValue: newMdm ? "Yes" : "No",
                    });
                    serial.mdm = newMdm;
                }

                if (imagesChanged) {
                    changes.push({
                        field: `item:${serial.serialNumber}:images`,
                        label: `Images (${serial.serialNumber})`,
                        oldValue: `${(serial.images || []).length} image(s)`,
                        newValue: `${newImages.length} image(s)`,
                    });
                    serial.images = newImages;
                }

                if (descChanged || notesChanged || mdmChanged || imagesChanged) {
                    await serial.save({ session });
                }
            }
        }

        if (changes.length === 0) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "No changes detected", 400);
        }

        // ============================================================
        // EOD REVIEW RESET - every edit re-opens review, since review
        // must always reflect the latest edited state. A SUPER_ADMIN's
        // own edit needs no review (they are the reviewing authority).
        // ============================================================
        if (user.role !== "SUPER_ADMIN") {
            purchase.processStatus = "PENDING_REVIEW";
        } else {
            purchase.processStatus = null;
        }
        purchase.reviewedBy = null;
        purchase.reviewedAt = null;

        purchase.updatedBy = user._id;
        await purchase.save({ session });

        await PurchaseEditHistory.create([{
            purchaseId: purchase._id,
            editedBy: user._id,
            editedByRole: user.role || "",
            changes,
        }], { session });

        await session.commitTransaction();
        session.endSession();

        return successResponse(res, "Purchase updated successfully", {
            _id: purchase._id,
            processStatus: purchase.processStatus,
            changesCount: changes.length,
        });
    } catch (error) {
        await session.abortTransaction().catch(() => {});
        session.endSession();

        if (error.isValidation) {
            return errorResponse(res, error.message, 400);
        }

        console.error("Update Purchase Error:", error);
        return errorResponse(res, error.message || "Failed to update purchase", 500);
    }
};
