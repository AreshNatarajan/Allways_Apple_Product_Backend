// services/sale/showroomExchangeProcessor.service.js
//
// Showroom Re-Exchange (user-facing "Type 2"): a customer brings back a
// unit WE sold earlier (identified by serial number) and takes another
// product in a NEW sale. The unit goes straight back to AVAILABLE stock.
//
// Entirely separate from processTradeIn (external trade-in, creates a
// synthetic Purchase + new ProductSerial). Here NOTHING is purchased and
// NO ProductSerial is created: the existing serial is reused, keeping
// its original purchaseId and purchasePrice. Only
// ProductSerial.currentCostBasis changes (to the staff-entered exchange
// value) so the NEXT sale's profit is computed on what we really paid to
// take it back - see services/inventory/serialCostBasis.js.
//
// Two phases so the caller can keep the documented atomic order inside
// its single transaction:
//   resolveShowroomUnits()  - read-only; validates everything server-side
//   commitShowroomExchange()- after Sale.create: conditional serial
//                             update, history record, stock movement
import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Sale from "../../models/Sale.modal.js";
import SaleExchange from "../../models/SaleExchange.modal.js";
import SaleShowroomExchange from "../../models/SaleShowroomExchange.modal.js";
import { recordStockMovement } from "../purchase/recordStockMovement.js";
import { effectiveSerialCost } from "../inventory/serialCostBasis.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const SHOWROOM_UNIT_KIND = "SHOWROOM_UNIT";
export const isShowroomUnitItem = (it) => it?.exchangeKind === SHOWROOM_UNIT_KIND;

const normSerial = (s) => String(s || "").trim().toUpperCase();

const pickLine = (src, extra) => ({
    productName: src.productName || "",
    modelNumber: src.modelNumber || "",
    purchasePrice: Number(src.purchasePrice) || 0,
    sellingPrice: Number(src.sellingPrice) || 0,
    discount: Number(src.discount) || 0,
    subtotal: Number(src.subtotal) || 0,
    gstApplicable: !!src.gstApplicable,
    gstPercent: Number(src.gstPercent) || 0,
    gstAmount: Number(src.gstAmount) || 0,
    hsnCode: src.hsnCode || "",
    finalAmount: Number(src.finalAmount) || 0,
    ...extra,
});

/**
 * Validate a single serial number as a returnable showroom-sold unit.
 * Never trusts client ids: everything is looked up from the serial number.
 * Returns { error } or { unit } where unit carries the resolved docs.
 * Used by both the sale-create flow and the read-only lookup endpoint.
 */
export const resolveShowroomUnit = async ({ serialNumber, session = null }) => {
    const sn = normSerial(serialNumber);
    if (!sn) return { error: "Serial number is required" };

    const q = ProductSerial.findOne({ serialNumber: sn, isDeleted: false });
    if (session) q.session(session);
    const serial = await q;
    if (!serial) return { error: `Serial ${sn} was not found in the system` };

    if (serial.status !== "SOLD") {
        const hint =
            serial.status === "AVAILABLE"
                ? "it is already in stock (not sold)"
                : `its current status is ${serial.status}`;
        return { error: `Serial ${sn} cannot be replaced: ${hint}` };
    }
    if (!serial.saleId) {
        return { error: `Serial ${sn} is marked sold but has no sale reference` };
    }

    const sq = Sale.findOne({ _id: serial.saleId, isDeleted: false });
    if (session) sq.session(session);
    const originalSale = await sq;
    if (!originalSale) return { error: `Original sale for serial ${sn} was not found` };
    if (originalSale.status !== "COMPLETED") {
        return { error: `Original sale ${originalSale.saleNumber} is ${originalSale.status}, not COMPLETED` };
    }

    // Original line: the sale's own item, or (unit that entered that sale
    // through a SaleExchange, never added to sale.items) the exchange's
    // newItem.
    let line = null;
    const saleItem = (originalSale.items || []).find(
        (it) => it.isSerialized && String(it.productSerialId) === String(serial._id)
    );
    if (saleItem) {
        const o = typeof saleItem.toObject === "function" ? saleItem.toObject() : saleItem;
        line = pickLine(o, { source: "SALE_ITEM", saleExchangeId: null });
    } else {
        const eq = SaleExchange.findOne({
            saleId: originalSale._id,
            "newItem.productSerialId": serial._id,
            isDeleted: false,
        });
        if (session) eq.session(session);
        const ex = await eq;
        if (ex?.newItem) {
            const o = typeof ex.newItem.toObject === "function" ? ex.newItem.toObject() : ex.newItem;
            line = pickLine(o, { source: "SALE_EXCHANGE", saleExchangeId: ex._id });
        }
    }
    if (!line) {
        return { error: `Could not match serial ${sn} to a line on sale ${originalSale.saleNumber}` };
    }

    // Already surrendered from this very sale once.
    const dq = SaleShowroomExchange.findOne({
        originalSaleId: originalSale._id,
        productSerialId: serial._id,
        isDeleted: false,
    }).select("_id");
    if (session) dq.session(session);
    if (await dq) {
        return { error: `Serial ${sn} was already replaced (taken back) from sale ${originalSale.saleNumber}` };
    }

    return { unit: { serial, originalSale, line } };
};

/**
 * Phase 1 (read-only). `items` are the tradeInItems flagged
 * exchangeKind === SHOWROOM_UNIT (user-facing "Replacement"), carrying
 * TWO independent staff-entered values:
 *   purchasePrice -> Current Value: credited to the customer AND the
 *                    unit's new cost basis (exchangeValue below).
 *   sellingPrice  -> Sale Value: the new intended selling price of the
 *                    returned unit (ProductSerial.sellingPrice). It is
 *                    never derived from, or used as, the credit.
 * Returns { error } or { units, total } (total = Σ Current Value).
 */
export const resolveShowroomUnits = async ({ items, session }) => {
    const seen = new Set();
    const units = [];
    let total = 0;
    for (const it of items) {
        const sn = normSerial(it.serialNumber);
        if (seen.has(sn)) return { error: `Serial ${sn} appears more than once in this replacement` };
        seen.add(sn);

        const value = round2(it.purchasePrice);
        if (!(value > 0)) return { error: `Current Value for ${sn || "a unit"} must be greater than 0` };
        const saleValue = round2(it.sellingPrice);
        if (!(saleValue > 0)) return { error: `Sale Value for ${sn || "a unit"} must be greater than 0` };

        const r = await resolveShowroomUnit({ serialNumber: sn, session });
        if (r.error) return { error: r.error };
        units.push({
            ...r.unit,
            // Pre-generated so the Sale can embed it at creation time.
            recordId: new mongoose.Types.ObjectId(),
            exchangeValue: value,
            saleValue,
            conditionNote: String(it.notes || it.conditionNote || "").trim().slice(0, 1000),
        });
        total = round2(total + value);
    }
    return { units, total };
};

/**
 * Phase 2: after the new Sale exists. Conditional update guards against a
 * concurrent exchange/return/sale of the same unit - if the serial is no
 * longer SOLD against the original sale, nothing is written and the
 * caller rolls the whole transaction back.
 * Returns { error } or { ok: true }.
 */
export const commitShowroomExchange = async ({ units, newSale, branchId, user, session }) => {
    const exchangedAt = new Date();

    for (const u of units) {
        const { serial, originalSale, line, exchangeValue, saleValue, conditionNote } = u;
        const previousCostBasis = effectiveSerialCost(serial);
        const previousSellingPrice = Number(serial.sellingPrice) || 0;

        const upd = await ProductSerial.updateOne(
            { _id: serial._id, status: "SOLD", saleId: originalSale._id, isDeleted: false },
            {
                $set: {
                    status: "AVAILABLE",
                    saleId: null,
                    soldAt: null,
                    currentBranchId: branchId,
                    currentCostBasis: exchangeValue,
                    // Sale Value: new intended selling price (separate from
                    // the Current Value cost basis above).
                    sellingPrice: saleValue,
                },
            },
            { session }
        );
        if (upd.modifiedCount !== 1) {
            return { error: `Serial ${serial.serialNumber} changed while processing; please retry` };
        }

        const [rec] = await SaleShowroomExchange.create(
            [{
                _id: u.recordId,
                newSaleId: newSale._id,
                newSaleNumber: newSale.saleNumber,
                branchId,
                exchangedAt,
                productId: serial.productId,
                productName: line.productName,
                productSerialId: serial._id,
                serialNumber: serial.serialNumber,
                originalSaleId: originalSale._id,
                originalSaleNumber: originalSale.saleNumber,
                originalBranchId: originalSale.branchId || null,
                originalSoldAt: serial.soldAt || originalSale.saleDate || null,
                originalCustomerName: originalSale.customerSnapshot?.name || "",
                originalPurchaseId: serial.purchaseId,
                originalSaleLine: line,
                exchangeValue,
                saleValue,
                previousSellingPrice,
                originalPurchasePrice: Number(serial.purchasePrice) || 0,
                previousCostBasis,
                newCostBasis: exchangeValue,
                conditionNote,
                processStatus: "PENDING_REVIEW",
                createdBy: user._id,
            }],
            { session }
        );

        await recordStockMovement({
            type: "SHOWROOM_EXCHANGE_RETURN",
            productId: serial.productId,
            branchId,
            serialId: serial._id,
            quantityDelta: 1,
            unitCost: exchangeValue,
            gstApplicable: !!serial.gstApplicable,
            gstPercent: Number(serial.purchaseGstPercent) || 0,
            referenceType: "SaleShowroomExchange",
            referenceId: rec._id,
            performedBy: user._id,
            performedByName: user.name || "",
            notes: `Showroom unit returned via sale ${newSale.saleNumber} (orig. ${originalSale.saleNumber})`,
            session,
        });

    }
    return { ok: true };
};

/** Sale.tradeInItems[] entries for the resolved units (built pre-Sale.create). */
export const buildShowroomEmbed = (units) =>
    units.map((u) => ({
        productId: u.serial.productId,
        productName: u.line.productName,
        isSerialized: true,
        serialNumber: u.serial.serialNumber,
        quantity: 1,
        purchasePrice: u.exchangeValue,
        sellingPrice: u.saleValue,
        productSerialId: u.serial._id,
        batchStockId: null,
        exchangeKind: SHOWROOM_UNIT_KIND,
        showroomExchangeId: u.recordId,
    }));
