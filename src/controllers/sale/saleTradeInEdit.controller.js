// controllers/sale/saleTradeInEdit.controller.js
//
// Edit a sale's trade-in(s) (Type 2 Exchange - the customer's own products
// taken in part-payment) from the SALE side, plus the customer's details.
//
// A trade-in lives in three places that must stay in step:
//   - the sale (create-time trade-in: Sale.tradeInItems / tradeInTotalValue
//     / netPayableAmount) or a SaleTradeIn doc (post-sale trade-in: items /
//     totalValue / appliedToPending),
//   - the synthetic Purchase it created (source CUSTOMER_EXCHANGE),
//   - the real stock unit (ProductSerial) - product, serial, prices,
//     descriptions, photos, notes, MDM, iCloud.
// This edits all three in ONE transaction.
//
// Rules:
//   - Branch users may only edit their own branch's sales.
//   - Product / serial / exchange value / selling price can only change while
//     the unit is still AVAILABLE at the sale's branch (not sold, transferred,
//     in service, returned to a vendor...) - same principle as Purchase Edit's
//     corrections. Photos, descriptions, notes, MDM and iCloud can always change.
//   - A new serial must not already exist; product must be an active,
//     serialized product with an HSN code; exchange value > 0 and selling
//     price >= exchange value.
//   - A value change moves the sale's money: create-time trade-in ->
//     netPayableAmount / pendingAmount / paymentStatus; post-sale trade-in ->
//     appliedToPending / tradeInCreditApplied / pendingAmount / paymentStatus.
//     Refused when it would leave the customer overpaid (record a refund
//     instead), when the create-time value would exceed the sale amount, or
//     when a post-sale trade-in already paid the customer a refund.
//   - Customer details correct the customer's master record and the
//     snapshots on all of that customer's sales and trade-in purchases.
//   - Every save is logged (SaleEditHistory + PurchaseEditHistory) and sends
//     the sale / purchase / trade-in back to review.
// Non-serialized (quantity) trade-in items are shown but not editable here.

import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import SaleTradeIn from "../../models/SaleTradeIn.modal.js";
import Purchase from "../../models/Purchase.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Product from "../../models/Product.modal.js";
import Customer from "../../models/Customer.modal.js";
import SaleEditHistory from "../../models/SaleEditHistory.modal.js";
import PurchaseEditHistory from "../../models/PurchaseEditHistory.modal.js";
import { applyCustomerDetails } from "../../services/customer/customerDetails.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const validationError = (message, statusCode = 400) => {
    const err = new Error(message);
    err.isValidation = true;
    err.statusCode = statusCode;
    return err;
};

const itemsValue = (items) => round2((items || []).reduce((s, it) => s + (Number(it.purchasePrice) || 0) * (it.isSerialized ? 1 : Number(it.quantity) || 0), 0));

const canEditSale = (user, sale) => user.role === "SUPER_ADMIN" || String(sale.branchId) === String(user.branchId);

// Why a unit's product / serial / value can't change any more (null = it can).
const identityLockReason = (serial, sale) => {
    if (!serial) return "Stock unit not found";
    if (serial.status !== "AVAILABLE") return `Already ${String(serial.status).replace(/_/g, " ").toLowerCase()}`;
    if (String(serial.currentBranchId || "") !== String(sale.branchId)) return "Moved to another branch";
    return null;
};

const paymentStatusFor = (sale) =>
    sale.pendingAmount <= 0 ? "PAID" : (sale.paidAmount > 0 || (sale.tradeInCreditApplied || 0) > 0 ? "PARTIAL" : "UNPAID");

// ============================================================
// GET /api/sale/:id/trade-in-edit - everything the edit screen needs.
// ============================================================
export const getSaleTradeInEditController = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) return errorResponse(res, "Invalid sale ID", 400);
        const sale = await Sale.findOne({ _id: id, isDeleted: false }).lean();
        if (!sale) return errorResponse(res, "Sale not found", 404);
        if (!canEditSale(req.user, sale)) return errorResponse(res, "Only the branch that made this sale can edit its trade-in", 403);
        if (sale.status === "CANCELLED") return errorResponse(res, "A cancelled sale's trade-in can't be edited", 400);

        const customer = sale.customerId
            ? await Customer.findOne({ _id: sale.customerId, isDeleted: false }).select("name mobile email address").lean()
            : null;

        const groups = [];
        if (sale.tradeInEnabled && sale.tradeInPurchaseId) {
            groups.push({ key: "SALE", label: "Trade-in at sale", at: sale.saleDate, items: sale.tradeInItems || [], purchaseId: sale.tradeInPurchaseId, totalValue: sale.tradeInTotalValue || itemsValue(sale.tradeInItems), valueLockReason: null });
        }
        const postSale = await SaleTradeIn.find({ saleId: sale._id, isDeleted: false }).sort({ createdAt: 1 }).lean();
        for (const t of postSale) {
            groups.push({
                key: String(t._id),
                label: "Trade-in after sale",
                at: t.tradeInAt || t.createdAt,
                items: t.items || [],
                purchaseId: t.tradeInPurchaseId,
                totalValue: t.totalValue,
                processStatus: t.processStatus,
                valueLockReason: t.processStatus === "REJECTED"
                    ? "This trade-in was rejected"
                    : t.settlementType === "COMPANY_REFUNDS" ? "A refund was already paid for this trade-in" : null,
            });
        }

        const purchaseIds = groups.map((g) => g.purchaseId).filter(Boolean);
        const purchases = new Map((await Purchase.find({ _id: { $in: purchaseIds } }).select("purchaseNumber").lean()).map((p) => [String(p._id), p]));
        const serialIds = groups.flatMap((g) => g.items.map((it) => it.productSerialId)).filter(Boolean);
        const serials = new Map(
            (await ProductSerial.find({ _id: { $in: serialIds } })
                .select("productId serialNumber status currentBranchId purchasePrice sellingPrice description images notes mdm icloud")
                .lean()).map((s) => [String(s._id), s])
        );

        const tradeIns = groups.map((g) => ({
            key: g.key,
            label: g.label,
            at: g.at,
            processStatus: g.processStatus || null,
            purchaseId: g.purchaseId,
            purchaseNumber: purchases.get(String(g.purchaseId))?.purchaseNumber || "",
            totalValue: g.totalValue,
            valueLockReason: g.valueLockReason,
            items: g.items.map((it) => {
                const serial = it.productSerialId ? serials.get(String(it.productSerialId)) : null;
                return {
                    productId: it.productId,
                    productName: it.productName,
                    isSerialized: !!it.isSerialized,
                    serialNumber: it.serialNumber,
                    quantity: it.quantity,
                    purchasePrice: it.purchasePrice,
                    sellingPrice: it.sellingPrice,
                    productSerialId: it.productSerialId,
                    unit: serial ? {
                        status: serial.status,
                        description: serial.description || { main: "", second: "" },
                        images: serial.images || [],
                        notes: serial.notes || "",
                        mdm: !!serial.mdm,
                        icloud: !!serial.icloud,
                    } : null,
                    identityLockReason: it.isSerialized ? identityLockReason(serial, sale) : "Quantity items can't be edited here",
                };
            }),
        }));

        return successResponse(res, "Trade-in details retrieved", {
            sale: { _id: sale._id, saleNumber: sale.saleNumber, branchId: sale.branchId, totalAmount: sale.totalAmount, paidAmount: sale.paidAmount, pendingAmount: sale.pendingAmount, paymentStatus: sale.paymentStatus },
            customer,
            tradeIns,
        });
    } catch (error) {
        console.error("Get Sale Trade-In Edit Error:", error);
        return errorResponse(res, "Failed to load trade-in details", 500);
    }
};

// ============================================================
// PUT /api/sale/:id/trade-in-edit
// body: { customer?: { name, mobile, email, address },
//         tradeInKey?: "SALE" | "<SaleTradeIn id>",
//         items?: [{ productSerialId, productId?, serialNumber?, purchasePrice?, sellingPrice?,
//                    description?: { main, second }, images?, notes?, mdm?, icloud? }] }
// ============================================================
export const updateSaleTradeInController = async (req, res) => {
    const session = await mongoose.startSession();
    try {
        session.startTransaction();
        const { id } = req.params;
        const user = req.user;
        const isSuperAdmin = user.role === "SUPER_ADMIN";
        const { customer: customerInput, tradeInKey, items: itemEdits } = req.body || {};

        if (!mongoose.Types.ObjectId.isValid(id)) throw validationError("Invalid sale ID");
        const sale = await Sale.findOne({ _id: id, isDeleted: false }).session(session);
        if (!sale) throw validationError("Sale not found", 404);
        if (!canEditSale(user, sale)) throw validationError("Only the branch that made this sale can edit its trade-in", 403);
        if (sale.status === "CANCELLED") throw validationError("A cancelled sale's trade-in can't be edited");

        const saleChanges = [];

        // ---------------- customer details ----------------
        if (customerInput && typeof customerInput === "object") {
            if (!sale.customerId) throw validationError("This sale has no customer to edit");
            const customer = await Customer.findOne({ _id: sale.customerId, isDeleted: false }).session(session);
            if (!customer) throw validationError("Customer not found", 404);
            const customerChanges = await applyCustomerDetails(customer, customerInput, session);
            if (customerChanges.length > 0) {
                customer.updatedBy = user._id;
                customer.updatedByRole = user.role || "";
                // Only the corrected fields are validated, so an older customer
                // record missing some since-required field can still be fixed.
                await customer.save({ session, validateModifiedOnly: true });
                saleChanges.push(...customerChanges);

                // Correct the snapshots too, so every sale and trade-in purchase
                // of this customer shows the corrected details.
                const snap = { name: customer.name, mobile: customer.mobile || "", email: customer.email || "", address: customer.address || "" };
                await Sale.updateMany(
                    { customerId: customer._id },
                    { $set: { "customerSnapshot.name": snap.name, "customerSnapshot.mobile": snap.mobile, "customerSnapshot.email": snap.email, "customerSnapshot.address": snap.address } },
                    { session }
                );
                sale.customerSnapshot = { ...(sale.customerSnapshot?.toObject?.() || sale.customerSnapshot || {}), ...snap };

                const customerSales = await Sale.find({ customerId: customer._id }).select("_id tradeInPurchaseId").session(session).lean();
                const postSaleTradeIns = await SaleTradeIn.find({ saleId: { $in: customerSales.map((s) => s._id) } }).select("tradeInPurchaseId").session(session).lean();
                const purchaseIds = [...customerSales.map((s) => s.tradeInPurchaseId), ...postSaleTradeIns.map((t) => t.tradeInPurchaseId)].filter(Boolean);
                if (purchaseIds.length > 0) {
                    await Purchase.updateMany(
                        { _id: { $in: purchaseIds }, source: "CUSTOMER_EXCHANGE" },
                        { $set: { "vendorSnapshot.name": `${snap.name} (Trade-In)`, "vendorSnapshot.phone": snap.mobile, "vendorSnapshot.email": snap.email, "vendorSnapshot.address": snap.address } },
                        { session }
                    );
                }
            }
        }

        // ---------------- trade-in items ----------------
        let tradeInDoc = null;
        if (Array.isArray(itemEdits) && itemEdits.length > 0) {
            let items;
            let purchaseId;
            if (tradeInKey === "SALE") {
                if (!sale.tradeInEnabled || !sale.tradeInPurchaseId) throw validationError("This sale has no trade-in");
                items = sale.tradeInItems;
                purchaseId = sale.tradeInPurchaseId;
            } else {
                if (!tradeInKey || !mongoose.Types.ObjectId.isValid(tradeInKey)) throw validationError("Choose which trade-in to edit");
                tradeInDoc = await SaleTradeIn.findOne({ _id: tradeInKey, saleId: sale._id, isDeleted: false }).session(session);
                if (!tradeInDoc) throw validationError("Trade-in not found", 404);
                if (tradeInDoc.processStatus === "REJECTED") throw validationError("A rejected trade-in can't be edited");
                items = tradeInDoc.items;
                purchaseId = tradeInDoc.tradeInPurchaseId;
            }

            const purchase = await Purchase.findOne({ _id: purchaseId, source: "CUSTOMER_EXCHANGE", isDeleted: { $ne: true } }).session(session);
            if (!purchase) throw validationError("The trade-in's purchase was not found", 404);

            const purchaseChanges = [];
            const oldValue = itemsValue(items);

            for (const edit of itemEdits) {
                const entry = items.find((it) => it.productSerialId && String(it.productSerialId) === String(edit?.productSerialId));
                if (!entry) throw validationError("That unit isn't on this trade-in");
                if (!entry.isSerialized) throw validationError("Quantity items can't be edited here");

                const serial = await ProductSerial.findOne({ _id: entry.productSerialId, purchaseId: purchase._id, isDeleted: false }).session(session);
                if (!serial) throw validationError(`Stock unit for ${entry.serialNumber} not found`, 404);
                const label = serial.serialNumber;

                // ---- product / serial / prices ----
                const changingProduct = !!edit.productId && String(edit.productId) !== String(serial.productId);
                const newSerialNumber = edit.serialNumber !== undefined && String(edit.serialNumber).trim()
                    ? String(edit.serialNumber).trim().toUpperCase()
                    : serial.serialNumber;
                const changingSerial = newSerialNumber !== serial.serialNumber;
                const newPurchasePrice = edit.purchasePrice !== undefined ? round2(parseFloat(edit.purchasePrice) || 0) : serial.purchasePrice;
                const newSellingPrice = edit.sellingPrice !== undefined ? round2(parseFloat(edit.sellingPrice) || 0) : serial.sellingPrice;
                const changingPrice = newPurchasePrice !== serial.purchasePrice || newSellingPrice !== serial.sellingPrice;

                if (changingProduct || changingSerial || changingPrice) {
                    const lock = identityLockReason(serial, sale);
                    if (lock) throw validationError(`${label}: ${lock} - its product, serial and price can no longer change. Photos, descriptions, MDM and iCloud can still be edited.`);

                    let newProduct = null;
                    if (changingProduct) {
                        if (!mongoose.Types.ObjectId.isValid(edit.productId)) throw validationError("Invalid product");
                        newProduct = await Product.findOne({ _id: edit.productId, isDeleted: false }).session(session);
                        if (!newProduct) throw validationError("Product not found", 404);
                        if (!newProduct.isSerialized) throw validationError(`${newProduct.name} is not a serialized product`);
                        if (newProduct.isActive === false) throw validationError(`${newProduct.name} is deactivated`);
                        if (!newProduct.hsnCode?.trim()) throw validationError(`${newProduct.name} has no HSN/SAC code on the product master`);
                    }
                    if (changingSerial) {
                        const dupe = await ProductSerial.findOne({ _id: { $ne: serial._id }, serialNumber: newSerialNumber, isDeleted: false }).session(session);
                        if (dupe) throw validationError(`Serial number already exists: ${newSerialNumber}`);
                    }
                    if (newPurchasePrice <= 0) throw validationError(`${label}: exchange value must be greater than 0`);
                    if (newSellingPrice < newPurchasePrice) throw validationError(`${label}: selling price can't be less than the exchange value`);

                    const oldSerialNumber = serial.serialNumber;
                    if (changingProduct) {
                        const oldName = entry.productName || (await Product.findById(serial.productId).select("name").session(session).lean())?.name || "";
                        purchaseChanges.push({ field: `item:${oldSerialNumber}:product`, label: `Product (${oldSerialNumber})`, oldValue: oldName, newValue: newProduct.name });
                        serial.productId = newProduct._id;
                        serial.hsnCode = newProduct.hsnCode;
                        entry.productId = newProduct._id;
                        entry.productName = newProduct.name;
                    }
                    if (changingSerial) {
                        purchaseChanges.push({ field: `item:${oldSerialNumber}:serialNumber`, label: `Serial Number (${oldSerialNumber})`, oldValue: oldSerialNumber, newValue: newSerialNumber });
                        serial.serialNumber = newSerialNumber;
                        entry.serialNumber = newSerialNumber;
                    }
                    if (changingPrice) {
                        purchaseChanges.push({
                            field: `item:${newSerialNumber}:price`,
                            label: `Exchange value / selling price (${newSerialNumber})`,
                            oldValue: `${serial.purchasePrice} / ${serial.sellingPrice}`,
                            newValue: `${newPurchasePrice} / ${newSellingPrice}`,
                        });
                        serial.purchasePrice = newPurchasePrice;
                        serial.sellingPrice = newSellingPrice;
                        entry.purchasePrice = newPurchasePrice;
                        entry.sellingPrice = newSellingPrice;
                    }

                    const purchaseItem = purchase.items.find((it) => it.serialNumbers?.[0]?.serialNumber === oldSerialNumber);
                    if (purchaseItem) {
                        if (changingProduct) { purchaseItem.productId = newProduct._id; purchaseItem.hsnCode = newProduct.hsnCode; }
                        if (changingSerial) purchaseItem.serialNumbers = [{ serialNumber: newSerialNumber }];
                        purchaseItem.purchasePrice = newPurchasePrice;
                        purchaseItem.sellingPrice = newSellingPrice;
                        purchaseItem.totalPrice = newPurchasePrice;
                    }
                }

                // ---- descriptions / photos / notes / MDM / iCloud ----
                const sn = serial.serialNumber;
                if (edit.description && typeof edit.description === "object") {
                    const main = String(edit.description.main ?? serial.description?.main ?? "").trim();
                    const second = String(edit.description.second ?? serial.description?.second ?? "").trim();
                    if (main !== (serial.description?.main || "") || second !== (serial.description?.second || "")) {
                        purchaseChanges.push({ field: `item:${sn}:description`, label: `Description (${sn})`, oldValue: { main: serial.description?.main || "", second: serial.description?.second || "" }, newValue: { main, second } });
                        serial.description = { main, second };
                    }
                }
                if (Array.isArray(edit.images)) {
                    const images = edit.images
                        .filter((img) => img && typeof img.url === "string" && typeof img.key === "string" && img.url.trim() && img.key.trim())
                        .map((img, i) => ({
                            url: img.url.trim(),
                            key: img.key.trim(),
                            name: typeof img.name === "string" ? img.name.trim().slice(0, 200) : "",
                            position: Number.isFinite(img.position) && img.position >= 1 ? Math.trunc(img.position) : i + 1,
                        }));
                    if (JSON.stringify(images.map((i) => [i.key, i.position])) !== JSON.stringify((serial.images || []).map((i) => [i.key, i.position]))) {
                        purchaseChanges.push({ field: `item:${sn}:images`, label: `Photos (${sn})`, oldValue: (serial.images || []).length, newValue: images.length });
                        serial.images = images;
                    }
                }
                if (edit.notes !== undefined && String(edit.notes).trim() !== (serial.notes || "")) {
                    purchaseChanges.push({ field: `item:${sn}:notes`, label: `Notes (${sn})`, oldValue: serial.notes || "", newValue: String(edit.notes).trim() });
                    serial.notes = String(edit.notes).trim();
                }
                if (edit.mdm !== undefined && !!edit.mdm !== !!serial.mdm) {
                    purchaseChanges.push({ field: `item:${sn}:mdm`, label: `MDM (${sn})`, oldValue: serial.mdm ? "Yes" : "No", newValue: edit.mdm ? "Yes" : "No" });
                    serial.mdm = !!edit.mdm;
                }
                if (edit.icloud !== undefined && !!edit.icloud !== !!serial.icloud) {
                    purchaseChanges.push({ field: `item:${sn}:icloud`, label: `iCloud (${sn})`, oldValue: serial.icloud ? "Yes" : "No", newValue: edit.icloud ? "Yes" : "No" });
                    serial.icloud = !!edit.icloud;
                }

                await serial.save({ session });
            }

            // ---- money: a changed exchange value moves the sale's balance ----
            const newValue = itemsValue(items);
            const delta = round2(newValue - oldValue);
            if (delta !== 0) {
                const newPending = round2(sale.pendingAmount - delta);
                if (tradeInKey === "SALE") {
                    if (newValue > sale.totalAmount) throw validationError("The trade-in value can't be more than the sale amount");
                } else if (tradeInDoc.settlementType === "COMPANY_REFUNDS") {
                    throw validationError("A refund was already paid for this trade-in, so its value can't change. Photos, descriptions, MDM and iCloud can still be edited.");
                }
                if (newPending < 0) {
                    throw validationError(`This would leave the customer overpaid by ₹${Math.abs(newPending).toLocaleString("en-IN")}. Lower the value, or record a refund first.`);
                }

                saleChanges.push({ field: "tradeInValue", label: "Trade-in value", oldValue, newValue });
                saleChanges.push({ field: "pendingAmount", label: "Pending amount", oldValue: sale.pendingAmount, newValue: newPending });
                if (tradeInKey === "SALE") {
                    sale.tradeInTotalValue = newValue;
                    sale.netPayableAmount = round2((sale.netPayableAmount ?? round2(sale.totalAmount - oldValue)) - delta);
                } else {
                    tradeInDoc.totalValue = newValue;
                    tradeInDoc.appliedToPending = round2((tradeInDoc.appliedToPending || 0) + delta);
                    sale.tradeInCreditApplied = round2((sale.tradeInCreditApplied || 0) + delta);
                }
                sale.pendingAmount = newPending;
                const newStatus = paymentStatusFor(sale);
                if (newStatus !== sale.paymentStatus) saleChanges.push({ field: "paymentStatus", label: "Payment status", oldValue: sale.paymentStatus, newValue: newStatus });
                sale.paymentStatus = newStatus;

                purchase.totalAmount = round2(purchase.totalAmount + delta);
                // Settled by the price reduction on the sale, never by cash.
                purchase.paidAmount = purchase.totalAmount;
                purchase.pendingAmount = 0;
            }

            if (purchaseChanges.length > 0 || delta !== 0) {
                if (delta !== 0) purchaseChanges.push({ field: "totalAmount", label: "Total amount", oldValue: round2(purchase.totalAmount - delta), newValue: purchase.totalAmount });
                // Same as Purchase Edit: every edit re-opens review, whoever made it.
                purchase.processStatus = "PENDING_REVIEW";
                purchase.reviewedBy = null;
                purchase.reviewedAt = null;
                purchase.updatedBy = user._id;
                await purchase.save({ session });
                await PurchaseEditHistory.create([{ purchaseId: purchase._id, editedBy: user._id, editedByRole: user.role || "", changes: purchaseChanges }], { session });
                saleChanges.push(...purchaseChanges.map((c) => ({ ...c, field: `tradeIn.${c.field}`, label: `Trade-in: ${c.label}` })));
            }

            if (tradeInDoc && (purchaseChanges.length > 0 || delta !== 0)) {
                // Same rule as creating a post-sale trade-in: it always needs a fresh review.
                tradeInDoc.processStatus = "PENDING_REVIEW";
                tradeInDoc.reviewedBy = null;
                tradeInDoc.reviewedAt = null;
                tradeInDoc.updatedBy = user._id;
                await tradeInDoc.save({ session });
            }
        }

        if (saleChanges.length === 0) throw validationError("No changes detected");

        // Same EOD-review rule as Sale Edit.
        sale.processStatus = isSuperAdmin ? null : "PENDING_REVIEW";
        sale.reviewedBy = null;
        sale.reviewedAt = null;
        sale.updatedBy = user._id;
        await sale.save({ session });
        await SaleEditHistory.create([{ saleId: sale._id, editedBy: user._id, editedByRole: user.role || "", changes: saleChanges }], { session });

        await session.commitTransaction();
        session.endSession();
        return successResponse(res, "Trade-in updated", { saleId: sale._id, changesCount: saleChanges.length, pendingAmount: sale.pendingAmount, paymentStatus: sale.paymentStatus });
    } catch (error) {
        await session.abortTransaction().catch(() => {});
        session.endSession();
        if (error.isValidation) return errorResponse(res, error.message, error.statusCode || 400);
        console.error("Update Sale Trade-In Error:", error);
        return errorResponse(res, "Failed to update the trade-in", 500);
    }
};
