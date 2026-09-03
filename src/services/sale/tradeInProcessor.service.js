// services/sale/tradeInProcessor.service.js
//
// Type 2 Exchange (trade-in) - a customer gives us one or more old
// products (not ours, no prior history in this system) in part-payment
// for a new Sale. Every ProductSerial/BatchStock ever created in this
// app requires a real Purchase ancestor (both `purchaseId` fields are
// `required: true`), and Purchase itself requires a real, active
// Vendor - there is no lighter-weight bypass anywhere in the schema.
// Rather than loosen those constraints (which every report/invoice/
// IN-OUT-register downstream assumes hold), this reuses the exact same
// purchaseItemProcessor.service.js functions createPurchase.controller.js
// already uses, against a single lazily-created system Vendor, for ONE
// synthetic Purchase covering every trade-in item on this sale (mixed
// serialized+non-serialized, exactly like a normal multi-item purchase
// submission). purchasePrice on the created inventory is the item's own
// agreed exchange/acquisition value, entered per item - which is also,
// correctly, its future COGS basis when it's eventually resold.
//
// The resulting Purchase/Batch/BatchStock/ProductSerial all carry
// `source: "CUSTOMER_EXCHANGE"` (see each model's own comment) so this
// is never indistinguishable from a real vendor purchase in reports.
//
// Deliberately NOT the same thing as Type 1 Exchange (SaleExchange
// collection) or Sale Return - both of those only ever operate on an
// item that already exists in our own inventory/Sale history. This
// file is never called by, and never touches, either of those.
import Vendor from "../../models/Vendor.modal.js";
import Purchase from "../../models/Purchase.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import { generateDocumentNumber } from "../documentNumber.service.js";
import {
    resolveItemBranches,
    prepareItems,
    commitItemInventory,
} from "../purchase/purchaseItemProcessor.service.js";

const EXCHANGE_VENDOR_NAME = "Customer Exchange (Trade-In)";

// Lazily get-or-create the one system vendor every trade-in-received
// Purchase is recorded against - mirrors the getOrCreateGstConfig()
// singleton pattern already used elsewhere in this codebase.
const getOrCreateExchangeVendor = async (user, session) => {
    let vendor = await Vendor.findOne({ name: EXCHANGE_VENDOR_NAME, isDeleted: false }).session(session);
    if (vendor) return vendor;

    const created = await Vendor.create(
        [{
            name: EXCHANGE_VENDOR_NAME,
            notes: "System vendor - represents goods received from customers via Type 2 Exchange (Sale trade-in). Not a real supplier.",
            createdBy: user._id,
            createdByRole: user.role || "",
        }],
        { session }
    );
    return created[0];
};

/**
 * Validates the trade-in items and, if valid, creates ONE receiving
 * Purchase + real inventory records (ProductSerial/BatchStock, one per
 * item) inside the caller's existing transaction/session. `tradeInItems`
 * mirrors the exact shape a real Purchase Entry submission's `items[]`
 * uses - productId, serialNumber (serialized) or quantity (non-
 * serialized), purchasePrice, sellingPrice, gstApplicable/
 * purchaseGstPercent, description/notes/images/mdm (serialized only,
 * this is where "Condition" lives - see ProductSerial.modal.js). Returns
 * either `{ error }` or `{ tradeInItemsEmbed, purchaseId }` - the array
 * to embed on `Sale.tradeInItems` plus the one Purchase id for
 * `Sale.tradeInPurchaseId`.
 *
 * `customerName` (the sale's own customer, resolved by the caller) is
 * stamped into the created Purchase's `vendorSnapshot.name` instead of
 * the shared system vendor's own name - `vendorId` still correctly
 * points at that one real Vendor document (required FK), but every
 * display that reads vendorSnapshot.name for "who did this come from"
 * (Purchase list/detail, etc.) shows the actual customer, not the
 * generic bucket vendor. Falls back to the vendor's own name if no
 * customer name is available.
 */
export const processTradeIn = async ({ tradeInItems, branchId, saleNumber, customerName, gstConfig, user, session }) => {
    if (!Array.isArray(tradeInItems) || tradeInItems.length === 0) {
        return { error: "At least one exchange item is required" };
    }

    const { branchMap, error: branchError } = await resolveItemBranches(
        [{}], // isBranchFlow ignores item.branchId entirely - only userBranchId matters
        { isBranchFlow: true, userBranchId: branchId }
    );
    if (branchError) return { error: branchError };

    // Reshaped into exactly what prepareItems (the same function
    // createPurchase.controller.js feeds) expects per item.
    const items = tradeInItems.map((it) => ({
        productId: it.productId,
        serialNumber: it.isSerialized ? it.serialNumber : undefined,
        quantity: it.isSerialized ? 1 : (Number(it.quantity) || 0),
        purchasePrice: Number(it.purchasePrice) || 0,
        sellingPrice: Number(it.sellingPrice) || 0,
        gstApplicable: !!it.gstApplicable,
        purchaseGstPercent: Number(it.purchaseGstPercent) || 0,
        description: it.description,
        notes: it.notes,
        images: it.images,
        mdm: it.mdm,
    }));

    const phase1 = await prepareItems({
        items,
        isSuperAdmin: false,
        isBranchFlow: true,
        isDirectReceive: true,
        userBranchId: branchId,
        branchMap,
        session,
    });
    if (phase1.error) return { error: phase1.error };

    const vendor = await getOrCreateExchangeVendor(user, session);
    const purchaseNumber = await generateDocumentNumber("purchase", gstConfig.documentPrefixes.purchase, { session });
    const trimmedCustomerName = typeof customerName === "string" ? customerName.trim() : "";

    const purchase = new Purchase({
        purchaseNumber,
        vendorId: vendor._id,
        vendorSnapshot: {
            name: trimmedCustomerName ? `${trimmedCustomerName} (Trade-In)` : (vendor.name || ""),
            gstNumber: vendor.gstNumber || "",
            phone: vendor.phone || "",
            email: vendor.email || "",
            address: vendor.address || "",
        },
        branchId,
        poType: "BRANCH",
        source: "CUSTOMER_EXCHANGE",
        purchaseDate: new Date(),
        // "Paid" via the price reduction on the sale, not real cash -
        // there is nothing further to settle against this vendor.
        paymentStatus: "PAID",
        paidAmount: phase1.calculatedTotalAmount,
        pendingAmount: 0,
        items: phase1.processedItems,
        totalAmount: phase1.calculatedTotalAmount,
        notes: `Received via Type 2 Exchange - Sale ${saleNumber}`,
        status: "COMPLETED",
        createdBy: user._id,
        updatedBy: user._id,
        // Same universal creation rule as every other purchase - no
        // special-casing for this synthetic one.
        processStatus: "PENDING_REVIEW",
    });
    await purchase.save({ session });

    await commitItemInventory({
        purchase,
        phase1,
        isSuperAdmin: false,
        isDirectReceive: true,
        purchaseNumber,
        user,
        session,
    });

    // commitItemInventory doesn't return the created records' ids, so
    // they're looked up read-only here rather than modifying that
    // shared, already-battle-tested function's return shape. Matched
    // positionally against phase1.processedItems (same order
    // commitItemInventory created them in).
    const tradeInItemsEmbed = [];
    for (let i = 0; i < phase1.processedItems.length; i++) {
        const processedItem = phase1.processedItems[i];
        const sourceItem = tradeInItems[i];
        const isSerialized = processedItem.serialNumbers.length > 0;

        let productSerialId = null;
        let batchStockId = null;
        if (isSerialized) {
            const createdSerial = await ProductSerial.findOne({
                purchaseId: purchase._id,
                serialNumber: processedItem.serialNumbers[0].serialNumber,
            }).session(session);
            productSerialId = createdSerial?._id || null;
        } else {
            const createdBatchStock = await BatchStock.findOne({
                purchaseId: purchase._id,
                productId: processedItem.productId,
            }).session(session);
            batchStockId = createdBatchStock?._id || null;
        }

        tradeInItemsEmbed.push({
            productId: processedItem.productId,
            productName: sourceItem.productName || "",
            isSerialized,
            serialNumber: isSerialized ? processedItem.serialNumbers[0].serialNumber : "",
            quantity: isSerialized ? 1 : processedItem.quantity,
            purchasePrice: processedItem.purchasePrice,
            sellingPrice: processedItem.sellingPrice,
            productSerialId,
            batchStockId,
        });
    }

    return { tradeInItemsEmbed, purchaseId: purchase._id };
};
