// controllers/sale/updateSale.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Product from "../../models/Product.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Inventory from "../../models/Inventory.modal.js";
import Customer from "../../models/Customer.modal.js";
import Purchase from "../../models/Purchase.modal.js";
import SaleEditHistory from "../../models/SaleEditHistory.modal.js";
import SaleReturn from "../../models/SaleReturn.modal.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const buildValidationError = (message) => {
    const err = new Error(message);
    err.isValidation = true;
    return err;
};

const describeComplimentary = (c) => {
    if (!c) return "None";
    const given = [];
    if (c.bag) given.push("Bag");
    if (c.hub) given.push("Hub");
    if (c.msOffice) given.push("MS Office");
    if (c.case) given.push("Case");
    return given.length > 0 ? given.join(", ") : "None";
};

// ============================================================
// Sale Edit. Unlike Purchase Edit (whose item corrections are only
// ever allowed on units that HAVEN'T moved yet - see
// updatePurchase.controller.js's SERIAL_LOCKED_STATUSES), every
// existing Sale line is by definition already sold - so a correction
// here always means a real inventory reversal (release the old
// unit/batch qty back to stock) followed by reapplication (consume the
// new one), mirroring createSale.controller.js's own consumption logic
// in both directions. Customer/date/notes/payment are freely editable
// too (SALE_FROZEN_FIELDS is now just ["branchId"] - see Sale.modal.js).
// Complimentary (Bag/Hub/MS Office/Case) is a metadata-only field with
// no inventory implication, editable independently of a price/unit
// correction. Applies immediately (no pending-approval gate) - the
// safety net is EOD review: every edit here resets processStatus back
// to PENDING_REVIEW (unless the editor is already SUPER_ADMIN, who
// needs no one to review them), and every edit is logged to
// SaleEditHistory so that review has something concrete to look at.
// Totals are always recomputed fresh from the final items array at the
// end, never delta-tracked through the sections below - simpler and
// safer than trying to keep running deltas in sync across removals/
// corrections/additions.
//
// StockMovement is deliberately NOT written for release/re-consume
// steps on an EXISTING line (removedItems, itemCorrections) - it has a
// hard uniqueness guarantee of one row per (referenceType, referenceId,
// batchId/serialId, type) - see StockMovement.model.js's
// dedupe_movement_* indexes - which assumes each unit/batch is only
// ever touched ONCE per parent Sale. That holds for createSale's
// original consumption, but an edit can legitimately touch the SAME
// unit/batch under the SAME Sale more than once (e.g. correct away
// from a unit, then correct back to it later) - a second movement row
// for that exact tuple would violate the index outright (confirmed via
// this controller's own verification run). SaleEditHistory is the
// audit trail for these instead (full before/after values, who/when),
// and ProductSerial.status/BatchStock quantities/Inventory.quantity
// remain the correct, authoritative current-state numbers either way -
// only the granular movement ledger loses a row for an edit-driven
// touch. NEW items appended via `newItems` still get a normal "SALE"
// movement, same as createSale.controller.js, since those are
// genuinely first-time consumptions under this Sale in the common case.
// ============================================================

export const updateSaleController = async (req, res) => {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();

        const { id } = req.params;
        const user = req.user;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Invalid sale ID", 400);
        }

        const sale = await Sale.findOne({ _id: id, isDeleted: false }).session(session);

        if (!sale) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Sale not found", 404);
        }

        if (sale.status === "CANCELLED") {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Cannot edit a cancelled sale", 400);
        }

        const {
            customerId,
            saleDate,
            notes,
            paymentDetails,
            newItems,
            itemCorrections,
            removedItems,
        } = req.body;

        const changes = [];
        const gstConfig = await getOrCreateGstConfig({ session });

        // ============================================================
        // RETURNED ITEMS - LOCKED. Any item already returned (regardless
        // of the return's own review status - a REJECTED return is a
        // pure audit flag, it never reverses the stock/refund that
        // already applied at creation, see createSaleReturn.controller.js)
        // is completely locked here: no price/quantity/serial/batch
        // correction, no removal. Checked explicitly so an editor gets a
        // clear rejection instead of silently corrupting the stock math
        // this controller's own reversal logic below would otherwise
        // apply a second time on top of what the return already did.
        // ============================================================
        const existingReturns = await SaleReturn.find({ saleId: sale._id, isDeleted: false }).session(session);
        const returnedSerialIds = new Set();
        const returnedBatchIds = new Set();
        for (const ret of existingReturns) {
            for (const line of ret.items) {
                if (line.isSerialized) returnedSerialIds.add(String(line.productSerialId));
                else returnedBatchIds.add(String(line.batchId));
            }
        }

        // Working copy of the items array - every section below reads/
        // mutates this, sale.items is only written back once at the end.
        let workingItems = sale.items.map((it) => (it.toObject ? it.toObject() : { ...it }));

        // ============================================================
        // CUSTOMER
        // ============================================================
        if (customerId && String(customerId) !== String(sale.customerId)) {
            if (!mongoose.Types.ObjectId.isValid(customerId)) {
                throw buildValidationError("Invalid customer ID");
            }
            const customer = await Customer.findOne({ _id: customerId, isDeleted: false }).session(session);
            if (!customer) throw buildValidationError("Customer not found");
            if (!customer.isActive) throw buildValidationError("This customer is deactivated and cannot be used for this sale");

            changes.push({
                field: "customerId",
                label: "Customer",
                oldValue: sale.customerSnapshot?.name || "—",
                newValue: customer.name,
            });
            sale.customerId = customer._id;
            sale.customerSnapshot = {
                name: customer.name || "",
                mobile: customer.mobile || "",
                email: customer.email || "",
                gstNumber: customer.gstNumber || "",
            };
        }

        // ============================================================
        // SALE DATE
        // ============================================================
        if (saleDate) {
            const newDate = new Date(saleDate);
            const oldDate = new Date(sale.saleDate);
            if (!Number.isNaN(newDate.getTime()) && newDate.toISOString().slice(0, 10) !== oldDate.toISOString().slice(0, 10)) {
                changes.push({ field: "saleDate", label: "Sale Date", oldValue: oldDate, newValue: newDate });
                sale.saleDate = newDate;
            }
        }

        // ============================================================
        // NOTES
        // ============================================================
        if (notes !== undefined && notes !== (sale.notes || "")) {
            changes.push({ field: "notes", label: "Notes", oldValue: sale.notes || "—", newValue: notes || "—" });
            sale.notes = notes;
        }

        // ============================================================
        // REMOVED ITEMS - the user deleted a wrongly-added line entirely.
        // Reverses that line's stock effect and drops it from the array.
        // ============================================================
        const removedSerialIds = (removedItems?.serialized || []).filter((v) => v && mongoose.Types.ObjectId.isValid(v));
        const removedBatchIds = (removedItems?.nonSerialized || []).filter(Boolean).map(String);

        for (const serialId of removedSerialIds) {
            const idx = workingItems.findIndex((it) => it.isSerialized && String(it.productSerialId) === String(serialId));
            if (idx === -1) continue;
            const line = workingItems[idx];

            if (returnedSerialIds.has(String(serialId))) {
                throw buildValidationError(`Serial ${line.serialNumber} has already been returned and cannot be removed from this sale.`);
            }

            const serial = await ProductSerial.findOne({ _id: serialId, saleId: sale._id, status: "SOLD" }).session(session);
            if (!serial) {
                throw buildValidationError(`Serial ${line.serialNumber} has already been reconciled elsewhere and can't be removed from this sale.`);
            }

            serial.status = "AVAILABLE";
            serial.soldAt = null;
            serial.saleId = null;
            await serial.save({ session });

            changes.push({
                field: `item:${line.serialNumber}:removed`,
                label: `Removed Item (${line.serialNumber})`,
                oldValue: `${line.productName} · ${line.serialNumber}`,
                newValue: "Removed",
            });

            workingItems.splice(idx, 1);
        }

        for (const batchId of removedBatchIds) {
            const idx = workingItems.findIndex((it) => !it.isSerialized && String(it.batchId) === batchId);
            if (idx === -1) continue;
            const line = workingItems[idx];

            if (returnedBatchIds.has(batchId)) {
                throw buildValidationError(`Batch ${line.batchNumber} has already been returned and cannot be removed from this sale.`);
            }

            const batchStock = await BatchStock.findOne({ batchId: line.batchId, productId: line.productId, branchId: sale.branchId }).session(session);
            if (!batchStock) throw buildValidationError(`Batch ${line.batchNumber} not found for reversal.`);

            batchStock.availableQuantity += line.quantity;
            batchStock.soldQuantity = Math.max(0, batchStock.soldQuantity - line.quantity);
            if (batchStock.status === "EXHAUSTED" && batchStock.availableQuantity > 0) batchStock.status = "ACTIVE";
            await batchStock.save({ session });

            const inventory = await Inventory.findOne({ productId: line.productId, branchId: sale.branchId }).session(session);
            if (inventory) {
                inventory.quantity += line.quantity;
                await inventory.save({ session });
            }

            changes.push({
                field: `item:${line.batchNumber}:removed`,
                label: `Removed Item (Batch ${line.batchNumber})`,
                oldValue: `${line.productName} · Qty ${line.quantity}`,
                newValue: "Removed",
            });

            workingItems.splice(idx, 1);
        }

        // ============================================================
        // ITEM CORRECTIONS - SERIALIZED. newSerialNumber alone triggers
        // a full unit swap (productId is always derived from the
        // resolved unit itself, never separately client-supplied, so it
        // can never mismatch what was actually scanned).
        // ============================================================
        for (const corr of (itemCorrections?.serialized || [])) {
            const { productSerialId, newSerialNumber, sellingPrice: newSellingPriceRaw, discount: newDiscountRaw, complimentary } = corr || {};
            if (!productSerialId || !mongoose.Types.ObjectId.isValid(productSerialId)) continue;

            const idx = workingItems.findIndex((it) => it.isSerialized && String(it.productSerialId) === String(productSerialId));
            if (idx === -1) continue;
            const line = workingItems[idx];

            if (returnedSerialIds.has(String(productSerialId))) {
                throw buildValidationError(`Serial ${line.serialNumber} has already been returned and cannot be edited.`);
            }

            const currentSerial = await ProductSerial.findOne({ _id: productSerialId, saleId: sale._id, status: "SOLD" }).session(session);
            if (!currentSerial) {
                throw buildValidationError(`Serial ${line.serialNumber} has already been reconciled elsewhere and can't be corrected.`);
            }

            const swapValue = newSerialNumber ? newSerialNumber.trim().toUpperCase() : null;
            const swapping = !!swapValue && swapValue !== line.serialNumber;
            const newSellingPrice = newSellingPriceRaw !== undefined ? parseFloat(newSellingPriceRaw) || 0 : line.sellingPrice;
            const newDiscount = newDiscountRaw !== undefined ? parseFloat(newDiscountRaw) || 0 : line.discount;
            const priceChanged = newSellingPrice !== line.sellingPrice || newDiscount !== line.discount;

            let targetSerial = currentSerial;
            let targetProduct = null;

            if (swapping) {
                const found = await ProductSerial.findOne({
                    serialNumber: swapValue,
                    currentBranchId: sale.branchId,
                    status: "AVAILABLE",
                }).session(session);
                if (!found) throw buildValidationError(`Serial ${swapValue} is not available at this branch`);

                targetProduct = await Product.findOne({ _id: found.productId, isDeleted: false }).session(session);
                if (!targetProduct) throw buildValidationError(`Product not found for serial ${swapValue}`);
                if (!targetProduct.isSerialized) throw buildValidationError(`${targetProduct.name} is not a serialized product`);
                if (!targetProduct.hsnCode?.trim()) throw buildValidationError(`${targetProduct.name} has no HSN/SAC code set on the product master`);

                currentSerial.status = "AVAILABLE";
                currentSerial.soldAt = null;
                currentSerial.saleId = null;
                await currentSerial.save({ session });

                found.status = "SOLD";
                found.soldAt = new Date();
                found.saleId = sale._id;
                await found.save({ session });

                targetSerial = found;
            }

            const purchasePrice = targetSerial.purchasePrice || 0;
            const gstApplicable = targetSerial.gstApplicable || false;
            const gstPercent = gstApplicable ? (gstConfig.marginSchemeRate || 0) : 0;
            const hsnCode = targetSerial.hsnCode || targetProduct?.hsnCode || line.hsnCode || "";

            const subtotal = newSellingPrice;
            const taxableAmount = subtotal - newDiscount;
            if (taxableAmount < 0) throw buildValidationError(`Discount cannot exceed subtotal for ${targetSerial.serialNumber}`);

            let gstAmount = 0, profit = 0, profitAfterGst = 0;
            if (gstApplicable && gstPercent > 0) {
                profit = newSellingPrice - purchasePrice - newDiscount;
                if (profit > 0) {
                    gstAmount = round2((profit * gstPercent) / 100);
                    profitAfterGst = profit - gstAmount;
                } else {
                    profitAfterGst = profit;
                }
            } else {
                profit = newSellingPrice - purchasePrice - newDiscount;
                profitAfterGst = profit;
            }
            const finalAmount = round2(taxableAmount);

            if (swapping) {
                changes.push({
                    field: `item:${line.serialNumber}:product`,
                    label: `Product (${line.serialNumber})`,
                    oldValue: line.productName,
                    newValue: targetProduct.name,
                });
                changes.push({
                    field: `item:${line.serialNumber}:serialNumber`,
                    label: `Serial Number (was ${line.serialNumber})`,
                    oldValue: line.serialNumber,
                    newValue: targetSerial.serialNumber,
                });
            }

            if (priceChanged) {
                changes.push({
                    field: `item:${targetSerial.serialNumber}:price`,
                    label: `Price (${targetSerial.serialNumber})`,
                    oldValue: `Sale ${line.sellingPrice} / Discount ${line.discount}`,
                    newValue: `Sale ${newSellingPrice} / Discount ${newDiscount}`,
                });
            }

            const newComplimentary = {
                bag: complimentary?.bag !== undefined ? !!complimentary.bag : !!line.complimentary?.bag,
                hub: complimentary?.hub !== undefined ? !!complimentary.hub : !!line.complimentary?.hub,
                msOffice: complimentary?.msOffice !== undefined ? !!complimentary.msOffice : !!line.complimentary?.msOffice,
                case: complimentary?.case !== undefined ? !!complimentary.case : !!line.complimentary?.case,
            };
            if (complimentary && JSON.stringify(newComplimentary) !== JSON.stringify(line.complimentary || {})) {
                changes.push({
                    field: `item:${targetSerial.serialNumber}:complimentary`,
                    label: `Complimentary (${targetSerial.serialNumber})`,
                    oldValue: describeComplimentary(line.complimentary),
                    newValue: describeComplimentary(newComplimentary),
                });
            }

            workingItems[idx] = {
                ...line,
                productId: targetSerial.productId,
                productName: swapping ? targetProduct.name : line.productName,
                productCode: swapping ? (targetProduct.productCode || "") : line.productCode,
                modelNumber: swapping ? (targetProduct.modelNumber || "") : line.modelNumber,
                productSerialId: targetSerial._id,
                serialNumber: targetSerial.serialNumber,
                purchasePrice,
                sellingPrice: newSellingPrice,
                discount: newDiscount,
                gstApplicable,
                gstPercent,
                gstAmount,
                hsnCode,
                subtotal,
                finalAmount,
                profit,
                profitAfterGst,
                complimentary: newComplimentary,
            };
        }

        // ============================================================
        // ITEM CORRECTIONS - NON-SERIALIZED. newBatchId alone triggers a
        // full batch swap (productId always derived from the resolved
        // batch's own record).
        // ============================================================
        for (const corr of (itemCorrections?.nonSerialized || [])) {
            const { batchId, newBatchId, quantity: newQuantityRaw, sellingPrice: newSellingPriceRaw, discount: newDiscountRaw } = corr || {};
            if (!batchId) continue;

            const idx = workingItems.findIndex((it) => !it.isSerialized && String(it.batchId) === String(batchId));
            if (idx === -1) continue;
            const line = workingItems[idx];

            if (returnedBatchIds.has(String(batchId))) {
                throw buildValidationError(`Batch ${line.batchNumber} has already been returned and cannot be edited.`);
            }

            const currentBatchStock = await BatchStock.findOne({ batchId: line.batchId, productId: line.productId, branchId: sale.branchId }).session(session);
            if (!currentBatchStock) throw buildValidationError(`Batch ${line.batchNumber} not found for correction.`);

            const swapping = !!newBatchId && String(newBatchId) !== String(line.batchId);
            const newQuantity = newQuantityRaw !== undefined ? parseFloat(newQuantityRaw) || 0 : line.quantity;
            const newSellingPrice = newSellingPriceRaw !== undefined ? parseFloat(newSellingPriceRaw) || 0 : line.sellingPrice;
            const newDiscount = newDiscountRaw !== undefined ? parseFloat(newDiscountRaw) || 0 : line.discount;
            if (newQuantity <= 0) throw buildValidationError(`Quantity must be greater than 0 for ${line.productName}`);

            let targetBatchStock = currentBatchStock;
            let targetProduct = null;
            let batchPurchaseNumber = line.purchaseNumber;

            if (swapping) {
                const found = await BatchStock.findOne({
                    batchId: newBatchId,
                    branchId: sale.branchId,
                    status: "ACTIVE",
                    availableQuantity: { $gte: newQuantity },
                }).session(session);
                if (!found) throw buildValidationError(`Selected batch is not available or has insufficient stock`);

                targetProduct = await Product.findOne({ _id: found.productId, isDeleted: false }).session(session);
                if (!targetProduct) throw buildValidationError(`Product not found for the selected batch`);
                if (targetProduct.isSerialized) throw buildValidationError(`${targetProduct.name} is a serialized product, not a batch product`);
                if (!targetProduct.hsnCode?.trim()) throw buildValidationError(`${targetProduct.name} has no HSN/SAC code set on the product master`);

                currentBatchStock.availableQuantity += line.quantity;
                currentBatchStock.soldQuantity = Math.max(0, currentBatchStock.soldQuantity - line.quantity);
                if (currentBatchStock.status === "EXHAUSTED" && currentBatchStock.availableQuantity > 0) currentBatchStock.status = "ACTIVE";
                await currentBatchStock.save({ session });

                const oldInventory = await Inventory.findOne({ productId: line.productId, branchId: sale.branchId }).session(session);
                if (oldInventory) {
                    oldInventory.quantity += line.quantity;
                    await oldInventory.save({ session });
                }

                found.availableQuantity -= newQuantity;
                found.soldQuantity += newQuantity;
                if (found.availableQuantity === 0) found.status = "EXHAUSTED";
                await found.save({ session });

                const newInventory = await Inventory.findOne({ productId: found.productId, branchId: sale.branchId }).session(session);
                if (!newInventory || newInventory.quantity < newQuantity) throw buildValidationError(`Insufficient inventory for ${targetProduct.name}`);
                newInventory.quantity -= newQuantity;
                await newInventory.save({ session });

                if (found.purchaseId) {
                    const sourcePurchase = await Purchase.findById(found.purchaseId).select("purchaseNumber").session(session).lean();
                    batchPurchaseNumber = sourcePurchase?.purchaseNumber || "";
                }

                targetBatchStock = found;
            } else if (newQuantity !== line.quantity) {
                const qtyDelta = newQuantity - line.quantity;
                if (qtyDelta > 0 && currentBatchStock.availableQuantity < qtyDelta) {
                    throw buildValidationError(`Insufficient stock in batch ${line.batchNumber} to increase quantity`);
                }
                currentBatchStock.availableQuantity -= qtyDelta;
                currentBatchStock.soldQuantity += qtyDelta;
                if (currentBatchStock.availableQuantity === 0) currentBatchStock.status = "EXHAUSTED";
                else if (currentBatchStock.status === "EXHAUSTED" && currentBatchStock.availableQuantity > 0) currentBatchStock.status = "ACTIVE";
                await currentBatchStock.save({ session });

                const inventory = await Inventory.findOne({ productId: line.productId, branchId: sale.branchId }).session(session);
                if (qtyDelta > 0 && (!inventory || inventory.quantity < qtyDelta)) throw buildValidationError(`Insufficient inventory for ${line.productName}`);
                if (inventory) {
                    inventory.quantity -= qtyDelta;
                    await inventory.save({ session });
                }
            }

            const purchasePrice = targetBatchStock.purchasePrice || 0;
            const gstPercent = gstConfig.standardRate || 0;
            const linePurchaseGstPercent = targetBatchStock.purchaseGstPercent || 0;
            const linePurchaseGstAmount = linePurchaseGstPercent > 0 ? round2((purchasePrice * newQuantity * linePurchaseGstPercent) / 100) : 0;
            const hsnCode = targetProduct?.hsnCode || line.hsnCode || "";

            const subtotal = newSellingPrice * newQuantity;
            const taxableAmount = subtotal - newDiscount;
            if (taxableAmount < 0) throw buildValidationError(`Discount cannot exceed subtotal for ${line.productName}`);
            const gstAmount = gstPercent > 0 ? round2((taxableAmount * gstPercent) / 100) : 0;
            const finalAmount = round2(taxableAmount + gstAmount);
            const profit = round2((newSellingPrice - purchasePrice) * newQuantity - newDiscount);
            const profitAfterGst = round2(profit - gstAmount);

            const priceOrQtyChanged = newSellingPrice !== line.sellingPrice || newDiscount !== line.discount || newQuantity !== line.quantity;

            if (swapping) {
                changes.push({
                    field: `item:${line.batchNumber}:product`,
                    label: `Product (Batch ${line.batchNumber})`,
                    oldValue: line.productName,
                    newValue: targetProduct.name,
                });
                changes.push({
                    field: `item:${targetBatchStock.batchNumber}:batch`,
                    label: `Batch (was ${line.batchNumber})`,
                    oldValue: line.batchNumber,
                    newValue: targetBatchStock.batchNumber,
                });
            }
            if (priceOrQtyChanged) {
                changes.push({
                    field: `item:${targetBatchStock.batchNumber}:price`,
                    label: `Price/Qty (Batch ${targetBatchStock.batchNumber})`,
                    oldValue: `Qty ${line.quantity} · Sale ${line.sellingPrice} / Discount ${line.discount}`,
                    newValue: `Qty ${newQuantity} · Sale ${newSellingPrice} / Discount ${newDiscount}`,
                });
            }

            workingItems[idx] = {
                ...line,
                productId: targetBatchStock.productId,
                productName: swapping ? targetProduct.name : line.productName,
                productCode: swapping ? (targetProduct.productCode || "") : line.productCode,
                batchId: targetBatchStock.batchId,
                batchNumber: targetBatchStock.batchNumber || "",
                barcode: targetBatchStock.barcode || line.barcode || "",
                purchaseId: targetBatchStock.purchaseId || line.purchaseId || null,
                purchaseNumber: batchPurchaseNumber,
                quantity: newQuantity,
                purchasePrice,
                sellingPrice: newSellingPrice,
                discount: newDiscount,
                gstApplicable: true,
                gstPercent,
                gstAmount,
                purchaseGstPercent: linePurchaseGstPercent,
                purchaseGstAmount: linePurchaseGstAmount,
                hsnCode,
                subtotal,
                finalAmount,
                profit,
                profitAfterGst,
            };
        }

        // ============================================================
        // NEW ITEMS (append) - reuses createSale.controller.js's own
        // validation + consumption logic verbatim, just against this
        // existing sale's branch/session instead of a brand-new one.
        // ============================================================
        for (const row of (newItems?.serialized || [])) {
            const { productId, serialNumber, sellingPrice: sp, discount: disc } = row || {};
            if (!productId || !serialNumber) continue;

            const product = await Product.findOne({ _id: productId, isDeleted: false }).session(session);
            if (!product) throw buildValidationError(`Product not found: ${productId}`);
            if (!product.isSerialized) throw buildValidationError(`${product.name} is not a serialized product`);
            if (!product.hsnCode?.trim()) throw buildValidationError(`${product.name} has no HSN/SAC code set on the product master`);

            const sellingPrice = parseFloat(sp) || 0;
            const discount = parseFloat(disc) || 0;
            if (sellingPrice <= 0) throw buildValidationError(`Selling price must be greater than 0 for ${product.name}`);
            if (discount < 0) throw buildValidationError(`Discount cannot be negative for ${product.name}`);

            const serial = await ProductSerial.findOne({
                serialNumber: serialNumber.trim().toUpperCase(),
                productId: product._id,
                currentBranchId: sale.branchId,
                status: "AVAILABLE",
            }).session(session);
            if (!serial) throw buildValidationError(`Serial ${serialNumber} is not available at this branch`);

            const purchasePrice = serial.purchasePrice || 0;
            const gstApplicable = serial.gstApplicable || false;
            const gstPercent = gstApplicable ? (gstConfig.marginSchemeRate || 0) : 0;
            const hsnCode = serial.hsnCode || product.hsnCode || "";

            const subtotal = sellingPrice;
            const taxableAmount = subtotal - discount;
            if (taxableAmount < 0) throw buildValidationError(`Discount cannot exceed subtotal for ${product.name}`);

            let gstAmount = 0, profit = 0, profitAfterGst = 0;
            if (gstApplicable && gstPercent > 0) {
                profit = sellingPrice - purchasePrice - discount;
                if (profit > 0) {
                    gstAmount = round2((profit * gstPercent) / 100);
                    profitAfterGst = profit - gstAmount;
                } else {
                    profitAfterGst = profit;
                }
            } else {
                profit = sellingPrice - purchasePrice - discount;
                profitAfterGst = profit;
            }
            const finalAmount = round2(taxableAmount);

            serial.status = "SOLD";
            serial.soldAt = new Date();
            serial.saleId = sale._id;
            await serial.save({ session });

            await recordStockMovement({
                type: "SALE",
                productId: product._id,
                branchId: sale.branchId,
                serialId: serial._id,
                quantityDelta: -1,
                unitCost: purchasePrice,
                gstApplicable,
                gstPercent,
                referenceType: "Sale",
                referenceId: sale._id,
                performedBy: user._id,
                performedByName: user.name || "",
                notes: `Added to ${sale.saleNumber} via edit`,
                session,
            });

            workingItems.push({
                productId: product._id,
                productName: product.name || "",
                productCode: product.productCode || "",
                modelNumber: product.modelNumber || "",
                productSerialId: serial._id,
                serialNumber: serial.serialNumber,
                isSerialized: true,
                batchId: null,
                batchNumber: "",
                barcode: "",
                purchaseId: null,
                purchaseNumber: "",
                quantity: 1,
                purchasePrice,
                sellingPrice,
                gstApplicable,
                gstPercent,
                gstAmount,
                purchaseGstPercent: 0,
                purchaseGstAmount: 0,
                hsnCode,
                discount,
                subtotal,
                finalAmount,
                profit,
                profitAfterGst,
                complimentary: { bag: false, hub: false, msOffice: false, case: false },
            });

            changes.push({
                field: `item:${serial.serialNumber}:added`,
                label: "New Item",
                oldValue: "—",
                newValue: `${product.name} · ${serial.serialNumber}`,
            });
        }

        for (const row of (newItems?.nonSerialized || [])) {
            const { productId, batchId, quantity: qtyRaw, sellingPrice: sp, discount: disc } = row || {};
            if (!productId || !batchId) continue;

            const product = await Product.findOne({ _id: productId, isDeleted: false }).session(session);
            if (!product) throw buildValidationError(`Product not found: ${productId}`);
            if (product.isSerialized) throw buildValidationError(`${product.name} is a serialized product, not a batch product`);
            if (!product.hsnCode?.trim()) throw buildValidationError(`${product.name} has no HSN/SAC code set on the product master`);

            const quantity = parseFloat(qtyRaw) || 0;
            const sellingPrice = parseFloat(sp) || 0;
            const discount = parseFloat(disc) || 0;
            if (quantity <= 0) throw buildValidationError(`Quantity must be greater than 0 for ${product.name}`);
            if (sellingPrice <= 0) throw buildValidationError(`Selling price must be greater than 0 for ${product.name}`);
            if (discount < 0) throw buildValidationError(`Discount cannot be negative for ${product.name}`);

            const batchStock = await BatchStock.findOne({
                batchId,
                productId: product._id,
                branchId: sale.branchId,
                status: "ACTIVE",
                availableQuantity: { $gte: quantity },
            }).session(session);
            if (!batchStock) throw buildValidationError(`Selected batch is not available or has insufficient stock for ${product.name}`);

            const purchasePrice = batchStock.purchasePrice || 0;
            const gstPercent = gstConfig.standardRate || 0;
            const linePurchaseGstPercent = batchStock.purchaseGstPercent || 0;
            const linePurchaseGstAmount = linePurchaseGstPercent > 0 ? round2((purchasePrice * quantity * linePurchaseGstPercent) / 100) : 0;

            const subtotal = sellingPrice * quantity;
            const taxableAmount = subtotal - discount;
            if (taxableAmount < 0) throw buildValidationError(`Discount cannot exceed subtotal for ${product.name}`);
            const gstAmount = gstPercent > 0 ? round2((taxableAmount * gstPercent) / 100) : 0;
            const finalAmount = round2(taxableAmount + gstAmount);
            const profit = round2((sellingPrice - purchasePrice) * quantity - discount);
            const profitAfterGst = round2(profit - gstAmount);

            const inventory = await Inventory.findOne({ productId: product._id, branchId: sale.branchId }).session(session);
            if (!inventory || inventory.quantity < quantity) throw buildValidationError(`Insufficient stock for ${product.name}`);

            batchStock.availableQuantity -= quantity;
            batchStock.soldQuantity += quantity;
            if (batchStock.availableQuantity === 0) batchStock.status = "EXHAUSTED";
            await batchStock.save({ session });

            inventory.quantity -= quantity;
            await inventory.save({ session });

            await recordStockMovement({
                type: "SALE",
                productId: product._id,
                branchId: sale.branchId,
                batchId: batchStock.batchId,
                quantityDelta: -quantity,
                resultingAvailableQuantity: batchStock.availableQuantity,
                unitCost: purchasePrice,
                gstApplicable: true,
                gstPercent,
                referenceType: "Sale",
                referenceId: sale._id,
                performedBy: user._id,
                performedByName: user.name || "",
                notes: `Added to ${sale.saleNumber} via edit`,
                session,
            });

            let batchPurchaseNumber = "";
            if (batchStock.purchaseId) {
                const sourcePurchase = await Purchase.findById(batchStock.purchaseId).select("purchaseNumber").session(session).lean();
                batchPurchaseNumber = sourcePurchase?.purchaseNumber || "";
            }

            workingItems.push({
                productId: product._id,
                productName: product.name || "",
                productCode: product.productCode || "",
                productSerialId: null,
                serialNumber: "",
                isSerialized: false,
                batchId: batchStock.batchId,
                batchNumber: batchStock.batchNumber || "",
                barcode: batchStock.barcode || "",
                purchaseId: batchStock.purchaseId || null,
                purchaseNumber: batchPurchaseNumber,
                quantity,
                purchasePrice,
                sellingPrice,
                gstApplicable: true,
                gstPercent,
                gstAmount,
                purchaseGstPercent: linePurchaseGstPercent,
                purchaseGstAmount: linePurchaseGstAmount,
                hsnCode: product.hsnCode,
                discount,
                subtotal,
                finalAmount,
                profit,
                profitAfterGst,
            });

            changes.push({
                field: `item:${batchStock.batchNumber}:added`,
                label: "New Item",
                oldValue: "—",
                newValue: `${product.name} · Qty ${quantity}`,
            });
        }

        if (workingItems.length === 0) {
            throw buildValidationError("A sale must contain at least one item");
        }

        // ============================================================
        // RECOMPUTE TOTALS - summed fresh from the final items array.
        // ============================================================
        let subtotalAmount = 0, totalDiscount = 0, totalGstAmount = 0, totalPurchaseGstAmount = 0, totalProfit = 0, totalProfitAfterGst = 0, totalAmount = 0;
        for (const it of workingItems) {
            subtotalAmount += it.subtotal || 0;
            totalDiscount += it.discount || 0;
            totalGstAmount += it.gstAmount || 0;
            totalPurchaseGstAmount += it.purchaseGstAmount || 0;
            totalProfit += it.profit || 0;
            totalProfitAfterGst += it.profitAfterGst || 0;
            totalAmount += it.finalAmount || 0;
        }
        subtotalAmount = round2(subtotalAmount);
        totalDiscount = round2(totalDiscount);
        totalGstAmount = round2(totalGstAmount);
        totalPurchaseGstAmount = round2(totalPurchaseGstAmount);
        totalProfit = round2(totalProfit);
        totalProfitAfterGst = round2(totalProfitAfterGst);
        totalAmount = round2(totalAmount);

        if (totalAmount !== round2(sale.totalAmount)) {
            changes.push({ field: "totalAmount", label: "Total Amount", oldValue: sale.totalAmount, newValue: totalAmount });
        }

        // ============================================================
        // PAYMENT
        // ============================================================
        let finalPaymentDetails = sale.paymentDetails;
        if (paymentDetails !== undefined) {
            finalPaymentDetails = (paymentDetails || []).map((p) => ({
                amount: Number(p.amount) || 0,
                paymentDate: p.paymentDate ? new Date(p.paymentDate) : new Date(),
                paymentMethod: p.paymentMethod || "CASH",
                notes: p.notes || "",
                attachment: p.attachment || null,
                handledBy: { userId: user._id, name: user.name || "", role: user.role || "" },
            }));
        }
        const paidAmount = round2(finalPaymentDetails.reduce((sum, p) => sum + (p.amount || 0), 0));
        if (paidAmount > totalAmount) {
            throw buildValidationError(`Paid amount (${paidAmount}) exceeds total amount (${totalAmount})`);
        }
        const pendingAmount = round2(totalAmount - paidAmount);
        let paymentStatus = "UNPAID";
        if (paidAmount === totalAmount && totalAmount > 0) paymentStatus = "PAID";
        else if (paidAmount > 0 && paidAmount < totalAmount) paymentStatus = "PARTIAL";

        const oldPaymentSummary = `${sale.paymentStatus} · Paid ${sale.paidAmount ?? 0}`;
        const newPaymentSummary = `${paymentStatus} · Paid ${paidAmount}`;
        if (oldPaymentSummary !== newPaymentSummary) {
            changes.push({ field: "paymentDetails", label: "Payment Details", oldValue: oldPaymentSummary, newValue: newPaymentSummary });
        }

        if (changes.length === 0) {
            throw buildValidationError("No changes detected");
        }

        // ============================================================
        // EOD REVIEW RESET - every edit re-opens review, since review
        // must always reflect the latest edited state - regardless of
        // editor role, including SUPER_ADMIN's own edit (matches the
        // same "no one's own record is auto-approved" rule already
        // applied at creation time in createSale.controller.js).
        // ============================================================
        sale.processStatus = "PENDING_REVIEW";
        sale.reviewedBy = null;
        sale.reviewedAt = null;

        sale.items = workingItems;
        sale.subtotalAmount = subtotalAmount;
        sale.totalDiscount = totalDiscount;
        sale.totalGstAmount = totalGstAmount;
        sale.totalPurchaseGstAmount = totalPurchaseGstAmount;
        sale.totalProfit = totalProfit;
        sale.totalProfitAfterGst = totalProfitAfterGst;
        sale.totalAmount = totalAmount;
        sale.paymentDetails = finalPaymentDetails;
        sale.paidAmount = paidAmount;
        sale.pendingAmount = pendingAmount;
        sale.paymentStatus = paymentStatus;
        sale.updatedBy = user._id;

        await sale.save({ session });

        await SaleEditHistory.create([{
            saleId: sale._id,
            editedBy: user._id,
            editedByRole: user.role || "",
            changes,
        }], { session });

        await session.commitTransaction();
        session.endSession();

        return successResponse(res, "Sale updated successfully", {
            _id: sale._id,
            processStatus: sale.processStatus,
            changesCount: changes.length,
        });
    } catch (error) {
        await session.abortTransaction().catch(() => {});
        session.endSession();

        if (error.isValidation) {
            return errorResponse(res, error.message, 400);
        }

        console.error("Update Sale Error:", error);
        return errorResponse(res, error.message || "Failed to update sale", 500);
    }
};
