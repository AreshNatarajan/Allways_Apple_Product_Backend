// controllers/pendingReceives/getPurchaseReceiveDetails.controller.js
import mongoose from "mongoose";
import Purchase from "../../models/Purchase.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import PendingReceive from "../../models/PendingReceive.modal.js";
import Branch from "../../models/Branch.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import { deriveStatus } from "../../services/pendingReceive/receiveStatusHelper.js";

// Serialized units carry no per-unit "receive status" enum of their
// own - it's derived from status + receivedAt, mirroring exactly what
// bulkReceiveController writes on a successful receive.
const serialReceiveStatus = (serial) => {
  if (!serial.receivedAt) return "PENDING";
  if (serial.status === "AVAILABLE") return "RECEIVED";
  if (serial.status === "DAMAGED") return "DAMAGED";
  if (serial.status === "MISSING") return "MISSING";
  return serial.status; // e.g. SOLD, if it moved on after being received
};

export const getPurchaseReceiveDetailsController = async (req, res) => {
  try {
    const { purchaseId } = req.params;
    const user = req.user;

    if (!mongoose.Types.ObjectId.isValid(purchaseId)) {
      return errorResponse(res, "Invalid purchase id", 400);
    }

    // ============================================================
    // BRANCH SCOPE - this endpoint is inherently branch-scoped (a
    // CENTRAL purchase can span several destination branches, each
    // with its own independent receive progress). BRANCH_ADMIN/STAFF
    // are always forced to their own branch. SUPER_ADMIN has no branch
    // of their own, so they must specify one explicitly - previously
    // this endpoint unconditionally required `user.branchId`, which
    // meant a SUPER_ADMIN could never call it at all (real bug, fixed
    // here).
    // ============================================================
    let branchObjectId;
    if (user.role === "SUPER_ADMIN") {
      const { branchId } = req.query;
      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
        return errorResponse(res, "branchId query param is required for SUPER_ADMIN", 400);
      }
      branchObjectId = new mongoose.Types.ObjectId(branchId);
    } else {
      if (!user.branchId) return errorResponse(res, "Branch not assigned to user", 400);
      branchObjectId = new mongoose.Types.ObjectId(user.branchId);
    }

    const [purchase, branch] = await Promise.all([
      Purchase.findById(purchaseId).populate("vendorId", "name phone email gstNumber address").lean(),
      Branch.findById(branchObjectId).select("name code").lean(),
    ]);

    if (!purchase) return errorResponse(res, "Purchase not found", 404);
    if (!branch) return errorResponse(res, "Branch not found", 404);

    // ============================================================
    // SERIALIZED PRODUCTS - every serial assigned to this purchase +
    // branch, regardless of current status, so history (already
    // received/damaged/missing) is visible too, not just what's still
    // pending ("Return complete receive information").
    // ============================================================
    const serials = await ProductSerial.find({
      purchaseId,
      assignedBranchId: branchObjectId,
      isDeleted: false,
    })
      .select(
        "productId serialNumber modelNumber purchasePrice sellingPrice gstApplicable purchaseGstPercent purchaseGstAmount status receivedAt remarks"
      )
      .populate("productId", "name productCode")
      .lean();

    const serializedProducts = serials.map((s) => ({
      productId: s.productId?._id || null,
      productName: s.productId?.name || "",
      modelNumber: s.modelNumber,
      serialId: s._id,
      serialNumber: s.serialNumber,
      purchasePrice: s.purchasePrice,
      sellingPrice: s.sellingPrice,
      gstApplicable: s.gstApplicable,
      purchaseGstPercent: s.purchaseGstPercent,
      purchaseGstAmount: s.purchaseGstAmount,
      assignedBranch: { _id: branch._id, name: branch.name, code: branch.code },
      receiveStatus: serialReceiveStatus(s),
      remarks: s.remarks || "",
    }));

    // ============================================================
    // NON-SERIALIZED PRODUCTS - from this purchase+branch's
    // PendingReceive document. Pricing/GST come from Purchase.items
    // (the authoritative record of what was actually agreed at
    // purchase time), matched by productId - PendingReceive.items
    // never duplicated that data.
    // ============================================================
    const pendingReceive = await PendingReceive.findOne({
      purchaseId,
      branchId: branchObjectId,
      isDeleted: false,
    })
      .populate("items.productId", "name productCode")
      .lean();

    const nonSerializedProducts = (pendingReceive?.items || []).map((item) => {
      const purchaseItem = purchase.items.find(
        (pi) => pi.productId?.toString() === item.productId?._id?.toString()
      );
      const totalProcessed =
        (item.receivedQuantity || 0) + (item.damagedQuantity || 0) + (item.missingQuantity || 0) + (item.rejectedQuantity || 0);

      return {
        productId: item.productId?._id || null,
        productName: item.productId?.name || item.productName || "",
        batchId: item.batchId || null,
        batchNumber: item.batchNumber || "",
        purchasePrice: purchaseItem?.purchasePrice ?? null,
        sellingPrice: purchaseItem?.sellingPrice ?? null,
        gstApplicable: purchaseItem?.gstApplicable ?? true,
        purchaseGstPercent: purchaseItem?.purchaseGstPercent ?? 0,
        purchaseGstAmount: purchaseItem?.purchaseGstAmount ?? 0,
        assignedQty: item.orderedQuantity,
        receivedQty: item.receivedQuantity || 0,
        damagedQty: item.damagedQuantity || 0,
        missingQty: item.missingQuantity || 0,
        rejectedQty: item.rejectedQuantity || 0,
        pendingQty: Math.max(item.orderedQuantity - totalProcessed, 0),
        status: item.status,
        remarks: item.remarks || "",
      };
    });

    // ============================================================
    // SUMMARY - combined across both product types for this
    // purchase+branch, same status precedence as the list endpoint.
    // ============================================================
    const totals = { assignedQty: 0, receivedQty: 0, damagedQty: 0, missingQty: 0, rejectedQty: 0 };
    for (const s of serializedProducts) {
      totals.assignedQty += 1;
      if (s.receiveStatus === "RECEIVED") totals.receivedQty += 1;
      else if (s.receiveStatus === "DAMAGED") totals.damagedQty += 1;
      else if (s.receiveStatus === "MISSING") totals.missingQty += 1;
    }
    for (const n of nonSerializedProducts) {
      totals.assignedQty += n.assignedQty;
      totals.receivedQty += n.receivedQty;
      totals.damagedQty += n.damagedQty;
      totals.missingQty += n.missingQty;
      totals.rejectedQty += n.rejectedQty;
    }

    const summary = {
      ...totals,
      pendingQty: Math.max(
        totals.assignedQty - (totals.receivedQty + totals.damagedQty + totals.missingQty + totals.rejectedQty),
        0
      ),
      receivePercent: totals.assignedQty > 0 ? Math.round((totals.receivedQty / totals.assignedQty) * 10000) / 100 : 0,
      status: deriveStatus(totals),
    };

    return successResponse(res, "Purchase receive details retrieved successfully", {
      purchase: {
        _id: purchase._id,
        purchaseNumber: purchase.purchaseNumber,
        vendor: purchase.vendorId
          ? {
              _id: purchase.vendorId._id,
              name: purchase.vendorId.name,
              phone: purchase.vendorId.phone,
              email: purchase.vendorId.email,
            }
          : null,
        purchaseDate: purchase.purchaseDate,
        notes: purchase.notes || "",
        status: purchase.status,
        overallReceiveStatus: purchase.overallReceiveStatus || "PENDING",
      },
      branch: { _id: branch._id, name: branch.name, code: branch.code },
      serializedProducts,
      nonSerializedProducts,
      summary,
    });
  } catch (error) {
    console.error("Get Purchase Receive Details Error:", error);
    return errorResponse(res, error.message || "Failed to retrieve purchase details", 500);
  }
};
