// controllers/sale/createSale.controller.js
import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Inventory from "../../models/Inventory.modal.js";
import Product from "../../models/Product.modal.js";
import Purchase from "../../models/Purchase.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import User from "../../models/User.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { generateDocumentNumber } from "../../services/documentNumber.service.js";
import { generateSaleInvoicePdf } from "../../services/sale/generateSaleInvoicePdf.js";
import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const createSaleController = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    const user = req.user;
    const branchId = user?.branchId;

    try {
        // ============================================================
        // 1. EXTRACT PAYLOAD
        // ============================================================
        
        const {
            customerId,
            saleDate,
            items,
            paymentDetails = [],
            notes,
            signatureFile,
            status = "COMPLETED",
            // Accountability fields - required whenever the creator isn't
            // SUPER_ADMIN (see §2.5 below), optional for SUPER_ADMIN.
            handledByUserId = null,
            selfie = null,
        } = req.body;

        // ============================================================
        // 2. VALIDATE REQUIRED FIELDS
        // ============================================================
        
        if (!branchId) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Branch ID is required", 400);
        }

        if (!customerId) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Customer is required", 400);
        }

        if (!items || items.length === 0) {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, "Sale items are required", 400);
        }

        const rollback = async (message, statusCode = 400) => {
            await session.abortTransaction();
            session.endSession();
            return errorResponse(res, message, statusCode);
        };

        // ============================================================
        // 2.5 HANDLED-BY / SELFIE VALIDATION (accountability)
        // ============================================================
        // Sale has no CENTRAL/BRANCH poType split like Purchase - every
        // sale ties to req.user.branchId regardless of role, so the
        // mandatory-vs-optional line is drawn on role alone: a
        // SUPER_ADMIN entry is trusted/direct, everyone else (BRANCH_ADMIN,
        // STAFF) is a counter transaction that needs accountability.
        // Never trust a client-submitted name/role - always re-resolved
        // fresh from the DB (same rule as customerSnapshot).
        const isBranchFlow = user?.role !== "SUPER_ADMIN";
        let handledBySnapshot = null;
        let selfieSnapshot = null;
        let processStatus = null;

        if (isBranchFlow) {
            if (!handledByUserId) {
                return rollback("Handled By user is required for this sale");
            }
            if (!selfie || !selfie.key || !selfie.url) {
                return rollback("A selfie capture is required for this sale");
            }
        }

        if (handledByUserId) {
            if (!mongoose.Types.ObjectId.isValid(handledByUserId)) {
                return rollback("Invalid Handled By user ID");
            }
            const handledByUser = await User.findOne({
                _id: handledByUserId,
                isDeleted: false,
            }).session(session);

            if (!handledByUser || !handledByUser.isActive) {
                return rollback("Handled By user not found or inactive", 404);
            }
            if (
                isBranchFlow &&
                (!handledByUser.branchId || handledByUser.branchId.toString() !== branchId.toString())
            ) {
                return rollback("Handled By user does not belong to this branch");
            }

            handledBySnapshot = {
                userId: handledByUser._id,
                name: handledByUser.name || "",
                role: handledByUser.role || "",
            };
        }

        if (selfie && selfie.key && selfie.url) {
            selfieSnapshot = {
                key: selfie.key,
                url: selfie.url,
                uploadedAt: new Date(),
            };
        }

        if (isBranchFlow) {
            processStatus = "PENDING_REVIEW";
        }

        // ============================================================
        // 3. VALIDATE PAYMENT DETAILS
        // ============================================================
        
        const validatedPaymentDetails = paymentDetails.map(p => ({
            amount: Number(p.amount) || 0,
            paymentDate: p.paymentDate || new Date(),
            paymentMethod: p.paymentMethod || "CASH",
            notes: p.notes || "",
            attachment: p.attachment || null,
            // Never trust a client-supplied handler - always the
            // authenticated user recording this payment right now
            // (matches createPurchase.controller.js's identical pattern).
            handledBy: {
                userId: user._id,
                name: user.name || "",
                role: user.role || "",
            },
        }));

        // ============================================================
        // 4. PROCESS ITEMS
        // ============================================================
        
        // Richer than a plain id list - carries what's needed to record
        // a StockMovement per unit sold (unitCost/gst snapshot at the
        // moment of sale), not just what's needed for the ProductSerial
        // update itself.
        const soldSerials = [];
        const batchStockUpdates = [];
        const inventoryUpdates = [];
        const saleItems = [];
        
        let calculatedSubtotalAmount = 0;
        let calculatedTotalDiscount = 0;
        let calculatedTotalGstAmount = 0;
        let calculatedTotalPurchaseGstAmount = 0;
        let calculatedTotalProfit = 0;
        let calculatedTotalProfitAfterGst = 0;
        let calculatedTotalAmount = 0;

        // Margin-scheme output GST rate - read ONCE for the whole
        // request (not per item, avoiding N+1), fresh from the current
        // GstConfig. "New transactions use current settings" - this
        // rate is stamped onto each serialized Sale.items[] entry below
        // and never re-read later, so a future rate change can never
        // retroactively alter this sale's historical record.
        const gstConfig = await getOrCreateGstConfig({ session });

        for (const item of items) {
            // ============================================================
            // 4a. VALIDATE PRODUCT
            // ============================================================
            
            const product = await Product.findOne({
                _id: item.productId,
                isDeleted: false,
            }).session(session);

            if (!product) {
                return rollback(`Product not found: ${item.productId}`);
            }

            const isSerialized = product.isSerialized || false;
            // A serialized item is always exactly one physical unit -
            // never trust/require a client-sent quantity for it (unlike
            // non-serialized, where quantity is required and validated
            // below). Silently defaulting an unset non-serialized
            // quantity to 1 previously masked a missing/invalid value;
            // for serialized it must still behave as 1 for the math.
            const quantity = isSerialized ? 1 : (Number(item.quantity) || 0);
            const sellingPrice = Number(item.sellingPrice) || 0;
            const discount = Number(item.discount) || 0;

            // gstPercent/gstApplicable/hsnCode are never trusted from the
            // client (tax fields) - each branch below overwrites these
            // from the authoritative source (ProductSerial for a
            // serialized unit, Product + BatchStock for a batch). The
            // request-supplied values are intentionally never read.
            let gstPercent = 0;
            let gstApplicable = false;
            let hsnCode = product.hsnCode || "";

            if (!hsnCode.trim()) {
                return rollback(`${product.name} has no HSN/SAC code set on the product master - update the product before selling`);
            }

            // Quantity must be a real positive number, not silently
            // defaulted - a 0/missing/invalid quantity is a bad request,
            // not "assume 1".
            if (!isSerialized && quantity <= 0) {
                return rollback(`Quantity must be greater than 0 for ${product.name}`);
            }

            // Validate selling price
            if (sellingPrice <= 0) {
                return rollback(`Selling price must be greater than 0 for ${product.name}`);
            }

            // Validate discount
            if (discount < 0) {
                return rollback(`Discount cannot be negative for ${product.name}`);
            }

            // ============================================================
            // 4b. CALCULATE ITEM FINANCIALS (Server-side)
            // ============================================================
            
            let purchasePrice = 0;
            let gstAmount = 0;
            let itemPurchaseGstAmount = 0;
            let profit = 0;
            let profitAfterGst = 0;
            let subtotal = 0;
            let finalAmount = 0;
            let taxableAmount = 0;

            if (isSerialized) {
                // ============================================================
                // SERIALIZED PRODUCT
                // ============================================================
                
                if (!item.productSerialId) {
                    return rollback(`Serial ID is required for ${product.name}`);
                }

                if (!item.serialNumber) {
                    return rollback(`Serial number is required for ${product.name}`);
                }

                // ✅ Find and validate serial - branch/availability are
                // enforced directly in the query (never a client-trusted
                // branchId, never a SOLD/DAMAGED/IN_TRANSIT serial).
                const serialRecord = await ProductSerial.findOne({
                    _id: item.productSerialId,
                    productId: product._id,
                    currentBranchId: branchId,
                    status: "AVAILABLE",
                }).session(session);

                if (!serialRecord) {
                    return rollback(`Serial ${item.serialNumber} is not available at this branch`);
                }

                // ✅ Authoritative historical cost + purchase-time GST
                // toggle, straight from this exact physical unit's own
                // record - never re-derived by searching the parent
                // Purchase's items[] by productId, which can silently
                // match a DIFFERENT unit of the same product bought in
                // the same purchase.
                purchasePrice = serialRecord.purchasePrice || 0;
                gstApplicable = serialRecord.gstApplicable || false;
                // Margin-scheme output GST - read fresh from the current
                // GstConfig, never from ProductSerial.saleGstPercent
                // (that field is permanently unpopulated - see its own
                // schema comment). Purchase GST and Sale GST are
                // deliberately different concepts: purchaseGstPercent is
                // input tax paid at purchase time, this is output tax
                // charged now, on the margin, at whatever rate is
                // currently configured - never derived from each other.
                gstPercent = gstConfig.marginSchemeRate || 0;
                // This physical unit's own HSN, snapshotted at purchase
                // time - falls back to the live Product master only for
                // units purchased before this field existed.
                hsnCode = serialRecord.hsnCode || product.hsnCode || "";

                // ✅ Calculate financials for serialized product
                subtotal = sellingPrice * quantity;
                taxableAmount = subtotal - discount;

                if (taxableAmount < 0) {
                    return rollback(`Discount cannot exceed subtotal for ${product.name}`);
                }

                // ✅ GST on margin (second-hand goods) - this is output
                // tax owed BY THE DEALER to the government on their
                // margin, never an amount added to what the customer
                // pays. The selling price was already fixed at purchase
                // time and is the customer's full price as-is, so
                // gstAmount here is tracked only for totalGstAmount /
                // tax-payable reporting (see getProfitLoss.controller.js's
                // "Tax Payable to Government" figure) - it must NOT be
                // added into finalAmount/taxableAmount, unlike the
                // non-serialized branch below where GST genuinely is
                // charged to the customer on top of the price.
                if (gstApplicable && gstPercent > 0) {
                    profit = sellingPrice - purchasePrice - discount;
                    if (profit > 0) {
                        gstAmount = (profit * gstPercent) / 100;
                        profitAfterGst = profit - gstAmount;
                    } else {
                        gstAmount = 0;
                        profitAfterGst = profit;
                    }
                } else {
                    gstAmount = 0;
                    profit = sellingPrice - purchasePrice - discount;
                    profitAfterGst = profit;
                }

                finalAmount = taxableAmount;

                // ✅ Store serial for update + StockMovement
                soldSerials.push({
                    serialId: item.productSerialId,
                    productId: product._id,
                    purchasePrice,
                    gstApplicable,
                    gstPercent,
                });

                // ✅ Build sale item
                saleItems.push({
                    productId: product._id,
                    productName: product.name || "",
                    productCode: product.productCode || "",
                    modelNumber: product.modelNumber || "",
                    productSerialId: item.productSerialId,
                    serialNumber: item.serialNumber,
                    isSerialized: true,
                    batches: [],
                    quantity: 1,
                    purchasePrice: purchasePrice,
                    sellingPrice: sellingPrice,
                    gstApplicable: gstApplicable,
                    gstPercent: gstApplicable ? gstPercent : 0,
                    gstAmount: gstAmount,
                    // No input GST/ITC for a second-hand serialized
                    // purchase under the margin scheme - always 0 here,
                    // explicit rather than relying on the schema default
                    // for clarity (see Sale.modal.js's field comment).
                    purchaseGstPercent: 0,
                    purchaseGstAmount: 0,
                    hsnCode: hsnCode,
                    discount: discount,
                    subtotal: subtotal,
                    finalAmount: finalAmount,
                    profit: profit,
                    profitAfterGst: profitAfterGst,
                    // Complimentary accessories (Bag/Hub/MS Office/Case) -
                    // serialized only, never client-trusted beyond simple
                    // booleans (no inventory/financial implication, so no
                    // further validation needed). Defaults all-false when
                    // omitted, same as the schema itself.
                    complimentary: {
                        bag: !!item.complimentary?.bag,
                        hub: !!item.complimentary?.hub,
                        msOffice: !!item.complimentary?.msOffice,
                        case: !!item.complimentary?.case,
                    },
                });

            } else {
                // ============================================================
                // NON-SERIALIZED PRODUCT - exactly one batch per sale
                // line, matching Sale.modal.js's own documented design
                // (the flat batchId/batchNumber/barcode fields, "a
                // non-serialized sale line always represents exactly one
                // batch... a second batch becomes a second line, never
                // merged into this one"). The legacy batches[] array on
                // the schema is explicitly "never populated by new
                // sales" - the controller previously still wrote it
                // (with client-echoed purchasePrice, never validated
                // against the real BatchStock cost), out of sync with
                // the schema's own stated intent. Selling from two
                // batches now means two items in the request, mirroring
                // exactly how createPurchase.controller.js already
                // treats one physical unit/batch per item.
                // ============================================================

                const batches = item.batches || [];

                if (batches.length === 0) {
                    return rollback(`Batch information is required for ${product.name}`);
                }
                if (batches.length > 1) {
                    return rollback(`${product.name}: sell from one batch per line - split multiple batches into separate items`);
                }

                const batchData = batches[0];
                const batchQuantity = Number(batchData.quantity) || 0;

                if (batchQuantity <= 0) {
                    return rollback(`Invalid quantity for batch ${batchData.batchNumber || "unknown"}`);
                }
                if (batchQuantity !== quantity) {
                    return rollback(`Batch quantity (${batchQuantity}) does not match item quantity (${quantity}) for ${product.name}`);
                }

                // ✅ Find and validate BatchStock - branch/availability
                // enforced directly in the query, same as the serialized
                // branch above.
                const batchStock = await BatchStock.findOne({
                    batchId: batchData.batchId,
                    productId: product._id,
                    branchId: branchId,
                    status: "ACTIVE",
                    availableQuantity: { $gte: batchQuantity },
                }).session(session);

                if (!batchStock) {
                    return rollback(`Batch ${batchData.batchNumber || "unknown"} is not available or has insufficient stock`);
                }

                batchStockUpdates.push({
                    batchStock,
                    quantity: batchQuantity,
                    productId: product._id,
                    purchasePrice: batchStock.purchasePrice || 0,
                    gstApplicable: true,
                    // Live global rate, not the batch's own frozen
                    // purchase-time rate - see the matching comment
                    // below.
                    gstPercent: gstConfig.standardRate || 0,
                });

                // ✅ Authoritative cost straight from this exact batch's
                // own record - never client-supplied. GST rate is
                // deliberately NOT read from batchStock.purchaseGstPercent
                // here - the government can change the GST rate on goods
                // at any time, so a non-serialized SALE always charges
                // whatever rate is currently configured (GstConfig.
                // standardRate, the same "read fresh at the moment of
                // each sale" rule already used for marginSchemeRate on
                // the serialized branch above), never the rate that
                // happened to be in effect back when this batch was
                // purchased.
                purchasePrice = batchStock.purchasePrice || 0;
                gstApplicable = true; // non-serialized is always GST-applicable per business rule
                gstPercent = gstConfig.standardRate || 0;
                // Real input GST/ITC for this line - THIS is genuinely
                // the batch's own frozen purchase-time rate (unlike
                // gstPercent above, the sale's output rate). Captured
                // here, once, at sale time, so P&L never has to guess it
                // later from the wrong (output) rate - see
                // getProfitLoss.controller.js's GST-payable math.
                const linePurchaseGstPercent = batchStock.purchaseGstPercent || 0;
                const linePurchaseGstAmount = linePurchaseGstPercent > 0
                    ? (purchasePrice * quantity * linePurchaseGstPercent) / 100
                    : 0;
                itemPurchaseGstAmount = round2(linePurchaseGstAmount);

                // BatchStock doesn't itself carry purchaseNumber (only
                // purchaseId) - one lightweight lookup for traceability,
                // matching the purchaseId/purchaseNumber pairing already
                // used everywhere else in this codebase.
                let batchPurchaseNumber = "";
                if (batchStock.purchaseId) {
                    const sourcePurchase = await Purchase.findById(batchStock.purchaseId)
                        .select("purchaseNumber")
                        .session(session)
                        .lean();
                    batchPurchaseNumber = sourcePurchase?.purchaseNumber || "";
                }

                // ✅ Calculate financials for non-serialized product
                subtotal = sellingPrice * quantity;
                taxableAmount = subtotal - discount;

                if (taxableAmount < 0) {
                    return rollback(`Discount cannot exceed subtotal for ${product.name}`);
                }

                // ✅ GST on taxable amount (normal additive GST)
                gstAmount = gstPercent > 0 ? (taxableAmount * gstPercent) / 100 : 0;

                finalAmount = taxableAmount + gstAmount;
                profit = (sellingPrice - purchasePrice) * quantity - discount;
                profitAfterGst = profit - gstAmount;

                // ✅ Track inventory for update
                const inventory = await Inventory.findOne({
                    productId: product._id,
                    branchId: branchId,
                }).session(session);

                if (!inventory || inventory.quantity < quantity) {
                    return rollback(`Insufficient stock for ${product.name}. Available: ${inventory?.quantity || 0}, Requested: ${quantity}`);
                }

                inventoryUpdates.push({
                    inventory: inventory,
                    quantity: quantity,
                });

                // ✅ Build sale item - flat batch fields, straight from
                // the validated BatchStock document (never client-echoed).
                saleItems.push({
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
                    quantity: quantity,
                    purchasePrice: purchasePrice,
                    sellingPrice: sellingPrice,
                    gstApplicable: true,
                    gstPercent: gstPercent,
                    gstAmount: gstAmount,
                    purchaseGstPercent: linePurchaseGstPercent,
                    purchaseGstAmount: round2(linePurchaseGstAmount),
                    hsnCode: hsnCode,
                    discount: discount,
                    subtotal: subtotal,
                    finalAmount: finalAmount,
                    profit: profit,
                    profitAfterGst: profitAfterGst,
                });
            }

            // ✅ Accumulate totals
            calculatedSubtotalAmount += subtotal;
            calculatedTotalDiscount += discount;
            calculatedTotalGstAmount += gstAmount;
            calculatedTotalPurchaseGstAmount += itemPurchaseGstAmount;
            calculatedTotalProfit += profit;
            calculatedTotalProfitAfterGst += profitAfterGst;
            calculatedTotalAmount += finalAmount;
        }

        // ============================================================
        // 5. PAYMENT LOGIC
        // ============================================================
        
        const paidAmount = validatedPaymentDetails.reduce((sum, p) => sum + p.amount, 0);

        if (paidAmount > calculatedTotalAmount) {
            const sym = gstConfig.currency?.symbol || "₹";
            return rollback(`Paid amount (${sym}${paidAmount}) exceeds total amount (${sym}${calculatedTotalAmount})`);
        }

        const pendingAmount = calculatedTotalAmount - paidAmount;
        let paymentStatus = "UNPAID";

        if (paidAmount === calculatedTotalAmount && calculatedTotalAmount > 0) {
            paymentStatus = "PAID";
        } else if (paidAmount > 0 && paidAmount < calculatedTotalAmount) {
            paymentStatus = "PARTIAL";
        }

        // ============================================================
        // 6. GENERATE SALE NUMBER - atomic, prefix from Global Settings
        // (gstConfig already fetched above for the margin-scheme rate)
        // ============================================================

        const saleNumber = await generateDocumentNumber("sale", gstConfig.documentPrefixes.sale, { session });

        // ============================================================
        // 7. CREATE SALE
        // ============================================================
        
        const sale = await Sale.create(
            [{
                saleNumber,
                branchId,
                customerId,
                saleDate: saleDate || new Date(),
                items: saleItems,
                subtotalAmount: calculatedSubtotalAmount,
                totalDiscount: calculatedTotalDiscount,
                totalGstAmount: calculatedTotalGstAmount,
                totalPurchaseGstAmount: calculatedTotalPurchaseGstAmount,
                totalProfit: calculatedTotalProfit,
                totalProfitAfterGst: calculatedTotalProfitAfterGst,
                totalAmount: calculatedTotalAmount,
                paymentDetails: validatedPaymentDetails,
                paidAmount: paidAmount,
                pendingAmount: pendingAmount,
                paymentStatus: paymentStatus,
                status: status || "COMPLETED",
                signatureFile: signatureFile || null,
                notes: notes || "",
                // Accountability - see §2.5 above for how these were
                // resolved and validated.
                handledBy: handledBySnapshot || undefined,
                selfie: selfieSnapshot || undefined,
                processStatus,
                createdBy: user?._id,
                updatedBy: user?._id,
                isActive: status !== "CANCELLED",
                isDeleted: false,
            }],
            { session }
        );

        const createdSale = sale[0];

        // ============================================================
        // 8. UPDATE STOCK (Only if NOT DRAFT)
        // ============================================================
        
        if (status !== "DRAFT") {
            // ============================================================
            // 8a. UPDATE SERIALIZED PRODUCTS + StockMovement
            // ============================================================

            if (soldSerials.length > 0) {
                await ProductSerial.updateMany(
                    {
                        _id: { $in: soldSerials.map((s) => s.serialId) },
                    },
                    {
                        $set: {
                            status: "SOLD",
                            soldAt: new Date(),
                            saleId: createdSale._id,
                        },
                    },
                    { session }
                );

                for (const s of soldSerials) {
                    await recordStockMovement({
                        type: "SALE",
                        productId: s.productId,
                        branchId,
                        serialId: s.serialId,
                        quantityDelta: -1,
                        unitCost: s.purchasePrice,
                        gstApplicable: s.gstApplicable,
                        gstPercent: s.gstPercent,
                        referenceType: "Sale",
                        referenceId: createdSale._id,
                        performedBy: user._id,
                        performedByName: user.name || "",
                        notes: `Sold on ${createdSale.saleNumber}`,
                        session,
                    });
                }
            }

            // ============================================================
            // 8b. UPDATE BATCHSTOCK (Non-Serialized) + StockMovement
            // ============================================================

            for (const update of batchStockUpdates) {
                const batchStock = update.batchStock;
                batchStock.availableQuantity -= update.quantity;
                batchStock.soldQuantity += update.quantity;

                if (batchStock.availableQuantity === 0) {
                    batchStock.status = "EXHAUSTED";
                }

                await batchStock.save({ session });

                await recordStockMovement({
                    type: "SALE",
                    productId: update.productId,
                    branchId,
                    batchId: batchStock.batchId,
                    quantityDelta: -update.quantity,
                    resultingAvailableQuantity: batchStock.availableQuantity,
                    unitCost: update.purchasePrice,
                    gstApplicable: update.gstApplicable,
                    gstPercent: update.gstPercent,
                    referenceType: "Sale",
                    referenceId: createdSale._id,
                    performedBy: user._id,
                    performedByName: user.name || "",
                    notes: `${update.quantity} unit(s) sold on ${createdSale.saleNumber}`,
                    session,
                });
            }

            // ============================================================
            // 8c. UPDATE INVENTORY (Non-Serialized)
            // ============================================================

            for (const update of inventoryUpdates) {
                const inventory = update.inventory;
                inventory.quantity -= update.quantity;
                await inventory.save({ session });
            }
        }

        // ============================================================
        // 9. COMMIT TRANSACTION
        // ============================================================
        
        await session.commitTransaction();
        session.endSession();

        // ============================================================
        // 9b. GENERATE SYSTEM INVOICE PDF + UPLOAD TO S3 (after the
        // transaction commits - PDF/S3 failure must never fail or roll
        // back the sale itself; the stock movement and financial record
        // are what matter most. Only for a real, finalized sale - a
        // DRAFT isn't an actual transaction yet, so it gets no invoice
        // until it's completed.)
        // ============================================================

        let systemInvoiceUrl = null;
        if (status !== "DRAFT") {
            try {
                const saleForInvoice = await Sale.findById(createdSale._id)
                    .populate("customerId", "name mobile email")
                    .populate("branchId", "name address phones email bankDetails upiQrImage");

                const { url } = await generateSaleInvoicePdf(saleForInvoice.toObject());
                systemInvoiceUrl = url;

                createdSale.systemInvoiceFile = systemInvoiceUrl;
                await createdSale.save();
            } catch (pdfError) {
                console.error("System Invoice PDF/S3 Error:", pdfError);
            }
        }

        // ============================================================
        // 10. POPULATE RESPONSE
        // ============================================================

        const populatedSale = await Sale.findById(createdSale._id)
            .populate("customerId", "name mobile email")
            .populate("items.productId", "name productCode isSerialized")
            .populate("createdBy", "name email")
            .populate("updatedBy", "name email");

        const message = status === "DRAFT"
            ? "Sale draft saved successfully"
            : systemInvoiceUrl
                ? "Sale created successfully. System invoice generated."
                : "Sale created successfully. System invoice generation failed.";

        const responseData = {
            ...populatedSale.toObject(),
            discountSummary: {
                subtotal: calculatedSubtotalAmount,
                totalDiscount: calculatedTotalDiscount,
                totalAmount: calculatedTotalAmount,
            },
            gstSummary: {
                totalGstAmount: calculatedTotalGstAmount,
            },
            profitSummary: {
                totalProfit: calculatedTotalProfit,
                totalProfitAfterGst: calculatedTotalProfitAfterGst,
                averageMargin: calculatedTotalAmount > 0 
                    ? (calculatedTotalProfit / calculatedTotalAmount) * 100 
                    : 0,
            }
        };

        return successResponse(res, message, responseData, 201);

    } catch (error) {
        await session.abortTransaction();
        session.endSession();

        console.error("Create Sale Error:", error);

        if (error.code === 11000) {
            return errorResponse(res, "Duplicate sale number", 400);
        }

        return errorResponse(res, error.message || "Error creating sale", 500);
    }
};