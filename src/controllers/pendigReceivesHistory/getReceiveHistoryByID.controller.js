// controllers/receiveHistory/getReceiveHistoryById.controller.js
import ReceiveHistory from "../../models/ReceiveHistory.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const getReceiveHistoryByIdController = async (req, res) => {
    try {
        const { id } = req.params;
        const user = req.user;

        const record = await ReceiveHistory.findById(id)
            .populate('branchId', 'name code address phone')
            .populate('vendorId', 'name phone email address')
            .populate('receivedBy', 'name email')
            .populate('items.productId', 'name productCode category');

        if (!record) {
            return errorResponse(res, "Receive history record not found", 404);
        }

        // ✅ Check permission
        if (user.role === "BRANCH_ADMIN" && 
            record.branchId?._id?.toString() !== user.branchId?.toString()) {
            return errorResponse(res, "Access denied", 403);
        }

        // ✅ Transform items for better display
        const transformedItems = record.items.map(item => ({
            ...item.toObject(),
            productName: item.productId?.name || item.productName,
            productCode: item.productId?.productCode || item.productCode,
        }));

        const transformedRecord = {
            _id: record._id,
            purchaseId: record.purchaseId,
            purchaseNumber: record.purchaseNumber,
            branch: record.branchId ? {
                _id: record.branchId._id,
                name: record.branchId.name,
                code: record.branchId.code,
                address: record.branchId.address,
                phone: record.branchId.phone,
            } : null,
            branchName: record.branchName,
            vendor: record.vendorId ? {
                _id: record.vendorId._id,
                name: record.vendorId.name,
                phone: record.vendorId.phone,
                email: record.vendorId.email,
                address: record.vendorId.address,
            } : null,
            vendorName: record.vendorName,
            items: transformedItems,
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
        };

        return successResponse(res, "Receive history details retrieved", transformedRecord);

    } catch (error) {
        console.error("Get Receive History By ID Error:", error);
        return errorResponse(res, error.message || "Failed to retrieve receive history details", 500);
    }
};