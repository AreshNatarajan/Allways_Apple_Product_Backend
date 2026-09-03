// controllers/inventory/getSerializedItemDetail.controller.js
import ProductSerial from "../../models/ProductSerial.modal.js";
import StockMovement from "../../models/StockMovement.model.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { canViewInventoryCost } from "../../utils/stripInventoryCostFields.js";

// Movement type -> human timeline label/description. PURCHASE_RECEIVE_*
// covers both the CENTRAL (SUPER_ADMIN, received later at a branch) and
// DIRECT (BRANCH_ADMIN, received immediately) purchase paths with one
// "Purchase" step - the receive moment is what actually matters to a
// unit's own history, not which of the two purchase flows created it.
const MOVEMENT_LABELS = {
    PURCHASE_RECEIVE_DIRECT: { label: "Purchase", description: "Received via direct branch purchase" },
    PURCHASE_RECEIVE_CENTRAL: { label: "Receive", description: "Received at branch from a central purchase" },
    TRANSFER_OUT: { label: "Transfer", description: "Dispatched to another branch" },
    TRANSFER_IN: { label: "Transfer", description: "Received from another branch" },
    SALE: { label: "Sale", description: "Sold to a customer" },
    RETURN: { label: "Return", description: "Returned by customer" },
    DAMAGE: { label: "Damage", description: "Marked as damaged" },
    REJECT: { label: "Reject", description: "Rejected during receive" },
    ADJUSTMENT: { label: "Adjustment", description: "Manual stock adjustment" },
};

// URL/API-driven by design (unlike the previous state-only detail page)
// so a direct link or a page refresh always resolves correctly.
export const getSerializedItemDetailController = async (req, res) => {
    try {
        const { serialNumber } = req.params;
        const user = req.user;

        if (!serialNumber || !serialNumber.trim()) {
            return errorResponse(res, "Serial number is required", 400);
        }

        const item = await ProductSerial.findOne({
            serialNumber: serialNumber.trim().toUpperCase(),
            isDeleted: false,
        })
            .populate("productId", "name category productCode hsnCode modelNumber")
            .populate({
                path: "purchaseId",
                select: "purchaseNumber purchaseDate vendorId vendorSnapshot",
                populate: { path: "vendorId", select: "name phone email gstNumber" },
            })
            .populate("currentBranchId", "name code")
            .populate("assignedBranchId", "name code")
            .populate({
                path: "saleId",
                select: "saleNumber saleDate totalAmount customerId",
                populate: { path: "customerId", select: "name mobile" },
            });

        if (!item) {
            return errorResponse(res, "Serial not found", 404);
        }

        // Read-only stock visibility is open to every role, not just the
        // serial's own branch - needed so a branch user can check another
        // branch's stock before requesting a Transfer (mirrors the
        // Transfer flow's own unrestricted getProductAvailabilityController).
        // Cost fields below stay SUPER_ADMIN-only regardless of branch.

        // ---- timeline, built from the append-only StockMovement ledger ----
        const movements = await StockMovement.find({ serialId: item._id })
            .sort({ performedAt: 1 })
            .lean();

        const timeline = movements.map((m) => ({
            type: m.type,
            label: MOVEMENT_LABELS[m.type]?.label || m.type,
            description: MOVEMENT_LABELS[m.type]?.description || "",
            date: m.performedAt,
            performedByName: m.performedByName || "",
            branchFrom: m.branchFrom || null,
            branchTo: m.branchTo || null,
            future: false,
        }));

        const hasAdjustment = movements.some((m) => m.type === "ADJUSTMENT");
        const hasReturn = movements.some((m) => m.type === "RETURN");
        // Both "Return" and "Adjustment" are placeholders only when no
        // real movement of that type has ever happened to this unit -
        // a real RETURN movement (see createSaleReturn.controller.js)
        // already appears in the timeline above via the movements map.
        if (!hasReturn) {
            timeline.push({
                type: "RETURN",
                label: "Return",
                description: "No returns recorded",
                date: null,
                future: true,
            });
        }
        if (!hasAdjustment) {
            timeline.push({
                type: "ADJUSTMENT",
                label: "Adjustment",
                description: "No adjustments recorded",
                date: null,
                future: true,
            });
        }

        // Snapshot-first (matches PurchaseRow.jsx/VendorDetailsCard.jsx's
        // own explicit convention, and getSerializedInventory.controller.js's
        // matching fix) - reflects who this was actually from at purchase
        // time, including a Type 2 Exchange trade-in's customer name
        // (see tradeInProcessor.service.js), never a later live-Vendor edit.
        const vendor = item.purchaseId?.vendorSnapshot || item.purchaseId?.vendorId || null;
        const canViewCost = canViewInventoryCost(user.role);

        const purchaseDetails = {
            vendor: vendor ? { name: vendor.name, phone: vendor.phone || "", email: vendor.email || "" } : null,
            branch: item.currentBranchId ? { _id: item.currentBranchId._id, name: item.currentBranchId.name, code: item.currentBranchId.code } : null,
            purchaseNumber: item.purchaseId?.purchaseNumber || "-",
            sellingPrice: item.sellingPrice || 0,
            gstApplicable: !!item.gstApplicable,
            hsnCode: item.hsnCode || "",
            purchaseDate: item.purchaseId?.purchaseDate || item.createdAt,
        };
        if (canViewCost) {
            purchaseDetails.purchasePrice = item.purchasePrice || 0;
            purchaseDetails.purchaseGstPercent = item.purchaseGstPercent || 0;
            purchaseDetails.purchaseGstAmount = item.purchaseGstAmount || 0;
        }

        return successResponse(res, "Serial detail retrieved successfully", {
            _id: item._id,
            serialNumber: item.serialNumber,
            barcode: item.serialNumber,
            status: item.status,
            // Product-level fields only - name/category/HSN describe the
            // model in general. description/images are deliberately NOT
            // included here: for a serialized unit, Product.description/
            // images are never the source of truth (see serialInfo
            // below) - showing them here would be exactly the "generic
            // Product info presented as if it describes this specific
            // unit" mistake this architecture exists to avoid.
            product: item.productId ? {
                _id: item.productId._id,
                name: item.productId.name,
                category: item.productId.category,
                productCode: item.productId.productCode || "",
                hsnCode: item.productId.hsnCode || "",
            } : null,
            // This physical unit's own source of truth for description/
            // images/notes - modelNumber is the one exception, always
            // sourced live from the Product master above, never per-unit.
            serialInfo: {
                modelNumber: item.productId?.modelNumber || "",
                serialNumber: item.serialNumber,
                status: item.status,
                description: item.description || { main: "", second: "" },
                images: item.images || [],
                notes: item.notes || "",
            },
            purchaseDetails,
            receivedDate: item.receivedAt || null,
            soldDate: item.soldAt || null,
            transferDate: item.transferredAt || null,
            currentBranch: item.currentBranchId ? { _id: item.currentBranchId._id, name: item.currentBranchId.name, code: item.currentBranchId.code } : null,
            assignedBranch: item.assignedBranchId ? { _id: item.assignedBranchId._id, name: item.assignedBranchId.name, code: item.assignedBranchId.code } : null,
            sale: item.saleId ? {
                saleNumber: item.saleId.saleNumber,
                saleDate: item.saleId.saleDate,
                totalAmount: item.saleId.totalAmount,
                customer: item.saleId.customerId ? { name: item.saleId.customerId.name, mobile: item.saleId.customerId.mobile } : null,
            } : null,
            timeline,
        });
    } catch (error) {
        console.error("Get Serialized Item Detail Error:", error);
        return errorResponse(res, "Failed to retrieve serial detail", 500);
    }
};
