
// controllers/sale/getScannerBarcodeByAvailableProductController.js

import mongoose from "mongoose";
import ProductSerial from "../../models/ProductSerial.modal.js";
import BatchStock from "../../models/BatchStock.model.js";
import Purchase from "../../models/Purchase.modal.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";

import {
    successResponse,
    errorResponse,
} from "../../utils/responseHandler.js";

export const getScannerBarcodeByAvailableProductController = async (req, res) => {
    try {
        const { barcodeValue } = req.params;
        const userBranchId = req.user?.branchId;


        console.log(
            "getScannerBarcodeByAvailableProductController",
            "userBranchId:", userBranchId,
            "barcodeValue:", barcodeValue
        );  

        // ============================================================
        // 1. VALIDATION
        // ============================================================

        if (!userBranchId) {
            return errorResponse(
                res,
                "Branch not assigned to user",
                400
            );
        }

        if (!barcodeValue || barcodeValue.trim() === "") {
            return errorResponse(
                res,
                "Barcode value is required",
                400
            );
        }

        // Every sibling serial-lookup controller (bulkReceive,
        // packTransfer, receiveTransfer, getSerializedItemDetail)
        // normalizes to uppercase before querying, since
        // ProductSerial.serialNumber is always stored uppercase
        // (schema-level `uppercase: true`, and set that way at creation
        // in purchaseItemProcessor.service.js). This controller was the
        // one outlier only trimming - a lowercase-typed/scanned value
        // would silently 404 as "not found" even though it exists.
        const trimmedBarcode = barcodeValue.trim().toUpperCase();

        const branchObjectId = new mongoose.Types.ObjectId(userBranchId);

        // Read once, used only for the serialized/margin-scheme branch
        // below - always the CURRENT global rate, never a historical
        // one (nothing about a scan lookup is a stored record).
        const gstConfig = await getOrCreateGstConfig();

        // ============================================================
        // 2. SEARCH SERIALIZED PRODUCT
        // ============================================================
        //
        // Serialized product scanner value:
        //
        //     01622
        //
        // Search ProductSerial.serialNumber
        //
        // ============================================================

        // Deliberately looked up by serialNumber ALONE first - status/
        // branch are checked separately below with their own specific
        // error messages, instead of being baked into the existence
        // query. Folding "AVAILABLE" + "at this branch" into the find()
        // itself meant a unit that's genuinely in stock but RESERVED
        // (packed for an outbound transfer), IN_TRANSIT, ASSIGNED
        // (CENTRAL purchase not yet received), or simply sitting at a
        // different branch produced the exact same "no available
        // product found" as a barcode that's completely unknown to the
        // system - indistinguishable from real data corruption to
        // whoever's scanning, and impossible to diagnose from the
        // error message alone.
        const serialMatch = await ProductSerial.findOne({
            serialNumber: trimmedBarcode,
        })
            .populate(
                "productId",
                "name productCode category isSerialized hsnCode isActive isDeleted modelNumber"
            )
            .lean();

        console.log(
            "getScannerBarcodeByAvailableProductController",
            "serialMatch:", serialMatch
        );    

        if (serialMatch && serialMatch.productId) {
            const product = serialMatch.productId;

            // Deleted/deactivated products must never scan as sellable,
            // even if the physical unit itself is still AVAILABLE.
            if (product.isDeleted || !product.isActive) {
                return errorResponse(
                    res,
                    "This product is no longer active and cannot be sold",
                    404
                );
            }

            if (!product.hsnCode || !product.hsnCode.trim()) {
                return errorResponse(
                    res,
                    `${product.name} has no HSN/SAC code set on the product master`,
                    400
                );
            }

            // ----------------------------------------------------------
            // ELIGIBILITY - honest, specific reasons instead of a blanket
            // "not found" for a unit that genuinely exists but isn't
            // sellable right here, right now.
            // ----------------------------------------------------------

            const STATUS_MESSAGE = {
                ASSIGNED: `${product.name} (${serialMatch.serialNumber}) is assigned to a branch but hasn't been received yet`,
                RESERVED: `${product.name} (${serialMatch.serialNumber}) is reserved for an outbound transfer and cannot be sold right now`,
                IN_TRANSIT: `${product.name} (${serialMatch.serialNumber}) is in transit between branches`,
                SOLD: `${product.name} (${serialMatch.serialNumber}) has already been sold`,
                DAMAGED: `${product.name} (${serialMatch.serialNumber}) is marked as damaged and cannot be sold`,
                MISSING: `${product.name} (${serialMatch.serialNumber}) is marked as missing`,
            };

            if (serialMatch.status !== "AVAILABLE") {
                return errorResponse(
                    res,
                    STATUS_MESSAGE[serialMatch.status] || `${product.name} (${serialMatch.serialNumber}) is not currently available for sale (status: ${serialMatch.status})`,
                    404
                );
            }

            if (String(serialMatch.currentBranchId) !== String(branchObjectId)) {
                return errorResponse(
                    res,
                    `${product.name} (${serialMatch.serialNumber}) is available, but at a different branch`,
                    404
                );
            }

            // --------------------------------------------------------
            // Pricing/GST - authoritative straight off this exact
            // physical unit's own ProductSerial record, never re-derived
            // by searching the parent Purchase's items[] by productId
            // (that lookup is ambiguous the moment a purchase contains
            // two units of the same product). Model Number is the one
            // exception - it always comes live from the Product master
            // (`product.modelNumber`), never per-unit.
            // --------------------------------------------------------

            const purchasePrice = serialMatch.purchasePrice || 0;
            const sellingPrice = serialMatch.sellingPrice || 0;
            const gstApplicable = serialMatch.gstApplicable || false;
            // Margin-scheme output GST - the exact same source
            // createSale.controller.js itself reads at the moment of
            // sale (gstConfig.marginSchemeRate), so this preview can
            // never show a different rate than what actually gets
            // charged. serialMatch.saleGstPercent is a vestigial field
            // (see ProductSerial.modal.js) - always 0, no longer read
            // by anything that mutates data, kept only for backward
            // compatibility with any old document that happens to have it set.
            const gstPercent = gstConfig.marginSchemeRate || 0;

            // --------------------------------------------------------
            // Get available serial count
            // --------------------------------------------------------

            const serialCount =
                await ProductSerial.countDocuments({
                    productId: product._id,
                    currentBranchId: branchObjectId,
                    status: "AVAILABLE",
                });

            // --------------------------------------------------------
            // SERIALIZED RESPONSE
            // --------------------------------------------------------

            return successResponse(
                res,
                "Available product found",
                {
                    type: "serialized",

                    productId: product._id,
                    productName: product.name,
                    productCode: product.productCode || "",
                    category: product.category || "",

                    modelNumber: product.modelNumber || "",

                    isSerialized: true,

                    // Serial information
                    serialNumber:
                        serialMatch.serialNumber,

                    productSerialId:
                        serialMatch._id,

                    // Pricing - sellingPrice is what the Sale screen
                    // should populate; purchasePrice is retained only
                    // for server-side profit calculation, not for
                    // display as "the price."
                    purchasePrice,
                    sellingPrice,

                    // GST
                    gstApplicable,
                    gstPercent,
                    hsnCode: product.hsnCode,

                    // Stock
                    currentStock: serialCount,
                    serialCount,
                    isAvailable: serialCount > 0,
                }
            );
        }

        // ============================================================
        // 3. SEARCH NON-SERIALIZED PRODUCT BY BATCH BARCODE
        // ============================================================
        //
        // IMPORTANT:
        //
        // OLD:
        //     AAP30WCH
        //
        // NEW:
        //     AAP30WCH-MRI-B001
        //
        // Scanner searches BatchStock.barcode
        //
        // ============================================================

        // Same principle as the serialized lookup above - found by
        // barcode alone first, eligibility (branch/status/quantity)
        // checked separately with specific messages, rather than
        // collapsing "doesn't exist" and "exists but not here/sold out"
        // into the same generic 404.
        const batchStock = await BatchStock.findOne({
            barcode: trimmedBarcode,
        })
            .populate(
                "productId",
                "name productCode category isSerialized hsnCode isActive isDeleted"
            )
            .lean();

        if (batchStock && batchStock.productId) {
            const product = batchStock.productId;

            // --------------------------------------------------------
            // Make sure this is really a non-serialized product
            // --------------------------------------------------------

            if (product.isSerialized) {
                return errorResponse(
                    res,
                    "Invalid batch barcode for serialized product",
                    400
                );
            }

            // Deleted/deactivated products must never scan as sellable,
            // even if the batch itself still has available stock.
            if (product.isDeleted || !product.isActive) {
                return errorResponse(
                    res,
                    "This product is no longer active and cannot be sold",
                    404
                );
            }

            if (String(batchStock.branchId) !== String(branchObjectId)) {
                return errorResponse(
                    res,
                    `${product.name} (batch ${batchStock.batchNumber}) belongs to a different branch`,
                    404
                );
            }

            if (batchStock.status !== "ACTIVE") {
                return errorResponse(
                    res,
                    `${product.name} (batch ${batchStock.batchNumber}) is not active (status: ${batchStock.status})`,
                    404
                );
            }

            if (!(batchStock.availableQuantity > 0)) {
                return errorResponse(
                    res,
                    `${product.name} (batch ${batchStock.batchNumber}) is out of stock at this branch`,
                    404
                );
            }

            if (!product.hsnCode || !product.hsnCode.trim()) {
                return errorResponse(
                    res,
                    `${product.name} has no HSN/SAC code set on the product master`,
                    400
                );
            }

            // --------------------------------------------------------
            // Purchase lookup is only for purchaseNumber (traceability
            // display) - GST/HSN come from BatchStock/Product directly
            // below (BatchStock already carries its own
            // purchaseGstPercent/gstApplicable, stamped once at receive
            // time - no need to re-derive by searching back through the
            // parent Purchase's items[] for a matching productId+batchId).
            // --------------------------------------------------------

            const purchase = await Purchase.findById(
                batchStock.purchaseId
            )
                .select("purchaseNumber")
                .lean();

            // --------------------------------------------------------
            // Get total available stock for this product in branch
            // --------------------------------------------------------

            const stockSummary =
                await BatchStock.aggregate([
                    {
                        $match: {
                            productId: product._id,
                            branchId: branchObjectId,
                            status: "ACTIVE",
                        },
                    },
                    {
                        $group: {
                            _id: null,
                            availableQuantity: {
                                $sum: "$availableQuantity",
                            },
                        },
                    },
                ]);

            const totalAvailableQuantity =
                stockSummary[0]?.availableQuantity || 0;

            // --------------------------------------------------------
            // NON-SERIALIZED RESPONSE
            // --------------------------------------------------------

            return successResponse(
                res,
                "Available product found",
                {
                    type: "non-serialized",

                    // Product
                    productId: product._id,
                    productName: product.name,
                    productCode: product.productCode || "",
                    category: product.category || "",

                    isSerialized: false,

                    // ------------------------------------------------
                    // Exact Batch Information - the sale must deduct
                    // from this specific batch, never a random one.
                    // ------------------------------------------------

                    batchId: batchStock.batchId,
                    batchNumber: batchStock.batchNumber,
                    barcode: batchStock.barcode,

                    // Original purchase (display/traceability only)
                    purchaseId: batchStock.purchaseId,
                    purchaseNumber: purchase?.purchaseNumber || "",

                    // ------------------------------------------------
                    // Pricing - sellingPrice is what the Sale screen
                    // should populate; purchasePrice is retained only
                    // for server-side profit calculation.
                    // ------------------------------------------------

                    purchasePrice:
                        batchStock.purchasePrice || 0,

                    sellingPrice:
                        batchStock.sellingPrice || 0,

                    // ------------------------------------------------
                    // GST - gstApplicable is real batch state (always
                    // true for non-serialized, per business rule),  but
                    // the RATE is never the batch's own frozen
                    // purchase-time rate - the government can change GST
                    // on goods at any time, so a sale always charges
                    // whatever's currently configured (GstConfig.
                    // standardRate), matching what createSale.controller.js
                    // itself actually charges - this preview must show
                    // the exact same number the sale will be created
                    // with, never a stale one.
                    // ------------------------------------------------

                    gstApplicable:
                        batchStock.gstApplicable ?? true,

                    gstPercent:
                        gstConfig.standardRate || 0,

                    hsnCode: product.hsnCode,

                    // ------------------------------------------------
                    // Stock
                    // ------------------------------------------------

                    batchQuantity:
                        batchStock.quantity || 0,

                    batchAvailableQuantity:
                        batchStock.availableQuantity || 0,

                    currentStock:
                        totalAvailableQuantity,

                    isAvailable:
                        batchStock.availableQuantity > 0,
                }
            );
        }

        // ============================================================
        // 4. NOTHING FOUND
        // ============================================================

        return errorResponse(
            res,
            "No available product found for this barcode",
            404
        );

    } catch (error) {
        console.error(
            "Scanner Barcode Lookup Error:",
            error
        );

        return errorResponse(
            res,
            error.message ||
                "Failed to lookup barcode",
            500
        );
    }
};