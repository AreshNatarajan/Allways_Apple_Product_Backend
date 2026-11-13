import mongoose from "mongoose";
import Sale from "../../models/Sale.modal.js";
import SaleReturn from "../../models/SaleReturn.modal.js";
import Branch from "../../models/Branch.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// ============================================================
// DAILY SALES TEXT REPORT (read-only)
// GET /reports/daily-sales-text?branchId=&date=YYYY-MM-DD
//
// SALES ONLY. Returns never count as sales and no return data is ever
// sent back. Return records are read for exactly one purpose: deciding
// whether a sale has been FULLY returned (then it is excluded from both
// counts and the listing). Partially returned sales stay counted and are
// listed exactly as originally sold.
//
// Eligible sale: branch matches, isDeleted:false, status COMPLETED
// (excludes DRAFT/CANCELLED), processStatus != REJECTED, not fully
// returned.
//
// Dates are Indian business days (IST, UTC+05:30), computed explicitly
// so the result does not depend on the server's own timezone.
// ============================================================

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Start of an IST calendar day, as a UTC instant.
const istDayStart = (y, m, d) => new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);

const todayIST = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

const idStr = (v) => (v ? String(v) : "");

// A sale is fully returned when EVERY original line is covered by
// non-rejected, non-deleted returns. Serialized line: its unit was
// returned. Batch line: returned qty (capped at sold qty) >= sold qty.
const isFullyReturned = (sale, returns) => {
  if (!returns || returns.length === 0) return false;
  const items = sale.items || [];
  if (items.length === 0) return false;

  const returnedSerials = new Set();
  const returnedQtyByKey = new Map();
  for (const ret of returns) {
    for (const ri of ret.items || []) {
      if (ri.isSerialized) {
        if (ri.productSerialId) returnedSerials.add(idStr(ri.productSerialId));
      } else {
        const key = ri.batchId ? `b:${idStr(ri.batchId)}` : `p:${idStr(ri.productId)}`;
        returnedQtyByKey.set(key, (returnedQtyByKey.get(key) || 0) + (Number(ri.quantity) || 0));
      }
    }
  }

  return items.every((item) => {
    if (item.isSerialized) {
      return Boolean(item.productSerialId) && returnedSerials.has(idStr(item.productSerialId));
    }
    const sold = Number(item.quantity) || 0;
    if (sold <= 0) return true;
    const key = item.batchId ? `b:${idStr(item.batchId)}` : `p:${idStr(item.productId)}`;
    const returned = Math.min(returnedQtyByKey.get(key) || 0, sold);
    return returned >= sold;
  });
};

export const getDailySalesTextReportController = async (req, res) => {
  try {
    const user = req.user;
    const isSuperAdmin = user.role === "SUPER_ADMIN";
    const { branchId } = req.query;
    const date = req.query.date ? String(req.query.date) : todayIST();

    if (!DATE_RE.test(date)) {
      return errorResponse(res, "Invalid date. Use YYYY-MM-DD", 400);
    }
    const [y, m, d] = date.split("-").map(Number);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
      return errorResponse(res, "Invalid date. Use YYYY-MM-DD", 400);
    }

    // Branch scoping - never trusted from the client for branch roles.
    let branchObjectId;
    if (isSuperAdmin) {
      if (!branchId || !mongoose.Types.ObjectId.isValid(branchId)) {
        return errorResponse(res, "Select a branch to generate the sales report", 400);
      }
      branchObjectId = new mongoose.Types.ObjectId(branchId);
    } else {
      if (!user.branchId) {
        return errorResponse(res, "Branch not assigned to user", 400);
      }
      branchObjectId = new mongoose.Types.ObjectId(user.branchId);
    }

    const branch = await Branch.findOne({ _id: branchObjectId, isDeleted: false })
      .select("name code")
      .lean();
    if (!branch) return errorResponse(res, "Branch not found", 404);

    const dayStart = istDayStart(y, m, d);
    const dayEnd = new Date(istDayStart(y, m, d + 1).getTime() - 1);
    const monthStart = istDayStart(y, m, 1);

    const sales = await Sale.find({
      branchId: branchObjectId,
      isDeleted: false,
      status: "COMPLETED",
      processStatus: { $ne: "REJECTED" },
      saleDate: { $gte: monthStart, $lte: dayEnd },
    })
      .select(
        "saleNumber saleDate createdAt items.productId items.productName items.isSerialized items.productSerialId items.batchId items.quantity totalAmount paymentDetails.amount paymentDetails.paymentMethod paymentStatus paidAmount pendingAmount tradeInCreditApplied tradeInTotalValue",
      )
      .lean();

    // Returns are used ONLY to detect fully-returned sales.
    const returnsBySale = new Map();
    if (sales.length > 0) {
      const returns = await SaleReturn.find({
        saleId: { $in: sales.map((s) => s._id) },
        isDeleted: false,
        processStatus: { $ne: "REJECTED" },
      })
        .select("saleId items.productId items.isSerialized items.productSerialId items.batchId items.quantity")
        .lean();
      for (const ret of returns) {
        const key = idStr(ret.saleId);
        if (!returnsBySale.has(key)) returnsBySale.set(key, []);
        returnsBySale.get(key).push(ret);
      }
    }

    const eligible = sales.filter((s) => !isFullyReturned(s, returnsBySale.get(idStr(s._id))));

    const todaySales = eligible
      .filter((s) => {
        const t = new Date(s.saleDate).getTime();
        return t >= dayStart.getTime() && t <= dayEnd.getTime();
      })
      .sort((a, b) => {
        const byDate = new Date(a.saleDate) - new Date(b.saleDate);
        if (byDate !== 0) return byDate;
        const byCreated = new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
        if (byCreated !== 0) return byCreated;
        return String(a.saleNumber || "").localeCompare(String(b.saleNumber || ""));
      });

    const salesList = todaySales.map((s) => ({
      saleNumber: s.saleNumber || "",
      items: (s.items || []).map((it) => ({
        productName: it.productName || "",
        quantity: Number(it.quantity) || 1,
      })),
      totalAmount: Number(s.totalAmount) || 0,
      paymentStatus: s.paymentStatus || "UNPAID",
      paidAmount: Number(s.paidAmount) || 0,
      pendingAmount: Number(s.pendingAmount) || 0,
      payments: (s.paymentDetails || [])
        .filter((p) => Number(p.amount) > 0)
        .map((p) => ({ method: p.paymentMethod, amount: Number(p.amount) || 0 })),
      tradeInCredit: (Number(s.tradeInTotalValue) || 0) + (Number(s.tradeInCreditApplied) || 0),
    }));

    return successResponse(res, "Daily sales report retrieved successfully", {
      branch: { name: branch.name, code: branch.code },
      date,
      todayCount: todaySales.length,
      monthCount: eligible.length,
      sales: salesList,
    });
  } catch (error) {
    console.error("getDailySalesTextReportController error:", error);
    return errorResponse(res, "Failed to generate daily sales report", 500);
  }
};
