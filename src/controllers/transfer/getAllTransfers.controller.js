// controllers/transfer/getAllTransfers.controller.js
import mongoose from "mongoose";
import Transfer from "../../models/Transfer.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const STATUSES = ["PROCESSING", "PACKED", "DISPATCHED", "RECEIVED", "CANCELLED"];

const SORTABLE_FIELDS = {
    transferNumber: "transferNumber",
    status: "status",
    sourceBranchName: "sourceBranchName",
    destinationBranchName: "destinationBranchName",
    totalQuantity: "summary.totalQuantity",
    totalItems: "summary.totalItems",
    createdAt: "createdAt",
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One unified, sortable/filterable/paginated list - mirrors
// getAllPurchases.controller.js's/getAllSales.controller.js's own
// shape - replacing the old separate "pending" (active) vs "history"
// (completed) split, which doesn't exist anywhere else in this app.
// direction: outgoing (my branch is the source) / incoming (my branch
// is the destination) / all (either side) - replaces the old my-
// request/other-request ownership split, which no longer makes sense
// now that a transfer's creator IS unambiguously its source branch.
export const getAllTransfersController = async (req, res) => {
    try {
        const user = req.user;
        const {
            page = 1, limit = 10, search = "", status = "ALL",
            branchId, direction = "all", startDate, endDate,
            sortBy, sortOrder,
        } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        const filter = { isDeleted: false };

        // Branch scope: SUPER_ADMIN optionally views as any one branch via
        // `branchId`; everyone else is always scoped to their own branch.
        const scopeBranchId = user.role === "SUPER_ADMIN" ? branchId : user.branchId?.toString();
        if (scopeBranchId && scopeBranchId !== "ALL" && mongoose.Types.ObjectId.isValid(scopeBranchId)) {
            const branchObjectId = new mongoose.Types.ObjectId(scopeBranchId);
            if (direction === "outgoing") filter.sourceBranchId = branchObjectId;
            else if (direction === "incoming") filter.destinationBranchId = branchObjectId;
            else filter.$or = [{ sourceBranchId: branchObjectId }, { destinationBranchId: branchObjectId }];
        } else if (user.role !== "SUPER_ADMIN") {
            return errorResponse(res, "Branch not assigned to user", 400);
        }
        // SUPER_ADMIN with no branchId: unscoped, sees every transfer.

        if (status && status !== "ALL") {
            filter.status = status;
        }

        if (startDate || endDate) {
            const range = {};
            if (startDate) range.$gte = new Date(`${startDate}T00:00:00.000Z`);
            if (endDate) range.$lte = new Date(`${endDate}T23:59:59.999Z`);
            filter.createdAt = range;
        }

        if (search && search.trim() !== "") {
            const searchRegex = new RegExp(escapeRegex(search.trim()), "i");
            const searchOr = [
                { transferNumber: searchRegex },
                { sourceBranchName: searchRegex },
                { destinationBranchName: searchRegex },
                { "items.productName": searchRegex },
                { "items.productCode": searchRegex },
                { notes: searchRegex },
            ];
            filter.$and = [...(filter.$and || []), { $or: searchOr }];
        }

        const sortField = SORTABLE_FIELDS[sortBy] || "createdAt";
        const sortDir = sortOrder === "asc" ? 1 : -1;

        const [transfers, total] = await Promise.all([
            Transfer.find(filter)
                .populate("sourceBranchId", "name code")
                .populate("destinationBranchId", "name code")
                .populate("createdBy", "name email")
                .sort({ [sortField]: sortDir })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            Transfer.countDocuments(filter),
        ]);

        const transformedTransfers = transfers.map((transfer) => ({
            _id: transfer._id,
            transferNumber: transfer.transferNumber,
            sourceBranch: transfer.sourceBranchId || { name: transfer.sourceBranchName },
            destinationBranch: transfer.destinationBranchId || { name: transfer.destinationBranchName },
            sourceBranchName: transfer.sourceBranchName,
            destinationBranchName: transfer.destinationBranchName,
            status: transfer.status,
            notes: transfer.notes,
            summary: transfer.summary,
            createdByName: transfer.createdByName,
            createdAt: transfer.createdAt,
            dispatchedAt: transfer.dispatchedAt,
            receivedAt: transfer.receivedAt,
            cancelledAt: transfer.cancelledAt,
            moreItemsCount: Math.max(0, (transfer.items?.length || 0) - 1),
            firstItem: transfer.items?.[0]
                ? { productName: transfer.items[0].productName, isSerialized: transfer.items[0].isSerialized, quantity: transfer.items[0].quantity }
                : null,
        }));

        const statsFilter = { isDeleted: false };
        if (filter.$or) statsFilter.$or = filter.$or;
        if (filter.sourceBranchId) statsFilter.sourceBranchId = filter.sourceBranchId;
        if (filter.destinationBranchId) statsFilter.destinationBranchId = filter.destinationBranchId;

        const statusCounts = await Promise.all(STATUSES.map((s) => Transfer.countDocuments({ ...statsFilter, status: s })));
        const stats = { total: await Transfer.countDocuments(statsFilter) };
        STATUSES.forEach((s, i) => { stats[s.toLowerCase()] = statusCounts[i]; });

        return successResponse(res, "Transfers retrieved successfully", {
            transfers: transformedTransfers,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.max(1, Math.ceil(total / parseInt(limit))),
            },
            stats,
            filters: {
                search: search || "", status: status || "ALL", branchId: branchId || "ALL",
                direction: direction || "all", startDate: startDate || "", endDate: endDate || "",
                sortBy: sortBy || "", sortOrder: sortOrder || "desc",
            },
        });
    } catch (error) {
        console.error("Get All Transfers Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve transfers", 500);
    }
};
