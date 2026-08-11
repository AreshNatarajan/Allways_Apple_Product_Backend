// controllers/inventory/getSerializedItemDetail.controller.js
import ProductSerial from "../../models/ProductSerial.modal.js";
import StockMovement from "../../models/StockMovement.model.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

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
            .populate("productId", "name category productCode hsnCode")
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

        // BRANCH_ADMIN/STAFF may only view a serial that is (or was, in
        // transit) associated with their own branch - SUPER_ADMIN is
        // unrestricted.
        if (user.role !== "SUPER_ADMIN") {
            const ownBranch = user.branchId?.toString();
            const currentBranch = item.currentBranchId?._id?.toString();
            const assignedBranch = item.assignedBranchId?._id?.toString();
            if (!ownBranch || (ownBranch !== currentBranch && ownBranch !== assignedBranch)) {
                return errorResponse(res, "Access denied. You can only view serials assigned to your branch.", 403);
            }
        }

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
        // "Return" has no corresponding StockMovement type at all yet -
        // always a future placeholder. "Adjustment" is only a placeholder
        // when no real adjustment has ever happened to this unit.
        timeline.push({
            type: "RETURN",
            label: "Return",
            description: "Not yet supported",
            date: null,
            future: true,
        });
        if (!hasAdjustment) {
            timeline.push({
                type: "ADJUSTMENT",
                label: "Adjustment",
                description: "No adjustments recorded",
                date: null,
                future: true,
            });
        }

        const vendor = item.purchaseId?.vendorId || item.purchaseId?.vendorSnapshot || null;

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
            // This physical unit's own source of truth - description and
            // images belong here, never on `product` above.
            serialInfo: {
                modelNumber: item.modelNumber,
                serialNumber: item.serialNumber,
                status: item.status,
                description: item.description || "",
                images: item.images || [],
            },
            purchaseDetails: {
                vendor: vendor ? { name: vendor.name, phone: vendor.phone || "", email: vendor.email || "" } : null,
                branch: item.currentBranchId ? { _id: item.currentBranchId._id, name: item.currentBranchId.name, code: item.currentBranchId.code } : null,
                purchaseNumber: item.purchaseId?.purchaseNumber || "-",
                purchasePrice: item.purchasePrice || 0,
                sellingPrice: item.sellingPrice || 0,
                gstApplicable: !!item.gstApplicable,
                purchaseGstPercent: item.purchaseGstPercent || 0,
                purchaseGstAmount: item.purchaseGstAmount || 0,
                hsnCode: item.hsnCode || "",
                purchaseDate: item.purchaseId?.purchaseDate || item.createdAt,
            },
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
