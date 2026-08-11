// controllers/receiveHistory/getAllReceiveHistory.controller.js
import ReceiveHistory from "../../models/ReceiveHistory.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";
import paginate from "../../utils/pagination.js";
import { getBranchFilter } from "../../middleware/branchFilter.js";

export const getAllReceiveHistoryController = async (req, res) => {
    try {
        const { page, limit, skip } = paginate(req);
        const { search, status, startDate, endDate } = req.query;
        const user = req.user;

        // ✅ Build filter
        const filter = {};

        // ✅ Apply branch filter
        const branchFilter = getBranchFilter(user);
        Object.assign(filter, branchFilter);

        // ✅ Search functionality
        if (search && search.trim() !== "") {
            const searchRegex = new RegExp(search.trim(), "i");
            filter.$or = [
                { purchaseNumber: searchRegex },
                { vendorName: searchRegex },
                { receivedByName: searchRegex },
                { branchName: searchRegex },
            ];
        }

        // ✅ Status filter
        if (status && status !== "ALL") {
            filter.status = status;
        }

        // ✅ Date range filter
        if (startDate || endDate) {
            filter.receivedAt = {};
            if (startDate) filter.receivedAt.$gte = new Date(startDate);
            if (endDate) filter.receivedAt.$lte = new Date(endDate);
        }

        // ✅ Get history with pagination
        const history = await ReceiveHistory.find(filter)
            .populate('branchId', 'name code')
            .populate('vendorId', 'name phone email')
            .populate('receivedBy', 'name email')
            .sort({ receivedAt: -1 })
            .skip(skip)
            .limit(limit);

        const total = await ReceiveHistory.countDocuments(filter);

        // ✅ Transform data
        const transformedHistory = history.map(record => ({
            _id: record._id,
            purchaseId: record.purchaseId,
            purchaseNumber: record.purchaseNumber,
            branchId: record.branchId ? {
                _id: record.branchId._id,
                name: record.branchId.name,
                code: record.branchId.code,
            } : null,
            branchName: record.branchName,
            vendorId: record.vendorId ? {
                _id: record.vendorId._id,
                name: record.vendorId.name,
                phone: record.vendorId.phone,
                email: record.vendorId.email,
            } : null,
            vendorName: record.vendorName,
            summary: record.summary,
            receivedAt: record.receivedAt,
            receivedBy: record.receivedBy ? {
                _id: record.receivedBy._id,
                name: record.receivedBy.name,
                email: record.receivedBy.email,
            } : null,
            receivedByName: record.receivedByName,
            status: record.status,
            notes: record.notes,
            createdAt: record.createdAt,
            // ✅ Calculate days since
            daysSince: Math.ceil((new Date() - new Date(record.receivedAt)) / (1000 * 60 * 60 * 24)),
        }));

        // ✅ Statistics
        const stats = {
            total: total,
            completed: await ReceiveHistory.countDocuments({ ...filter, status: "COMPLETED" }),
            partial: await ReceiveHistory.countDocuments({ ...filter, status: "PARTIAL" }),
            damaged: await ReceiveHistory.countDocuments({ ...filter, status: "DAMAGED" }),
            rejected: await ReceiveHistory.countDocuments({ ...filter, status: "REJECTED" }),
            totalItems: await ReceiveHistory.aggregate([
                { $match: filter },
                { $group: { _id: null, total: { $sum: "$summary.totalReceived" } } }
            ]).then(result => result[0]?.total || 0),
            totalAmount: await ReceiveHistory.aggregate([
                { $match: filter },
                { $group: { _id: null, total: { $sum: "$summary.totalAmount" } } }
            ]).then(result => result[0]?.total || 0),
        };

        return successResponse(res, "Receive history retrieved successfully", {
            history: transformedHistory,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total / limit),
            },
            stats,
            filters: {
                search: search || "",
                status: status || "ALL",
            }
        });

    } catch (error) {
        console.error("Get Receive History Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve receive history", 500);
    }
};