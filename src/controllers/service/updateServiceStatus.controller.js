// controllers/service/updateServiceStatus.controller.js
import mongoose from "mongoose";
import Service from "../../models/Service.modal.js";
import ServiceHistory from "../../models/ServiceHistory.modal.js";
import ServiceVendor from "../../models/ServiceVendor.modal.js";
import { releaseInventoryHold } from "../../services/service/releaseInventoryHold.js";
import { cascadeReturnIfSameBranch } from "../../services/service/sameBranchCascade.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// ============================================================
// UPDATE SERVICE STATUS - the one action-based endpoint, mirroring
// updateTransferStatus.controller.js exactly: one PUT, an `action`
// string, an inline if/else-if chain per action with an explicit
// current-status guard, a branch-involvement + permission check, and
// the status write + ServiceHistory entry created atomically in one
// transaction. Service is NOT Transfer - no Transfer/TransferHistory
// document is ever touched by any action here.
//
// Actions, in lifecycle order:
//   SEND_TO_SERVICE_BRANCH   - origin branch     CUSTOMER_RECEIVED -> SENT_TO_SERVICE_BRANCH
//   SERVICE_BRANCH_RECEIVE   - service branch     SENT_TO_SERVICE_BRANCH -> SERVICE_BRANCH_RECEIVED
//   ALLOCATE_VENDOR          - service branch     SERVICE_BRANCH_RECEIVED -> VENDOR_ALLOCATED (needs serviceVendorId)
//   START_PROCESSING         - service branch     VENDOR_ALLOCATED -> VENDOR_PROCESSING
//   VENDOR_RETURN            - service branch     VENDOR_PROCESSING -> VENDOR_RETURNED
//   MARK_FINISHED            - service branch     VENDOR_RETURNED -> FINISHED
//   SEND_TO_ORIGINAL_BRANCH  - service branch     FINISHED -> SENT_TO_ORIGINAL_BRANCH
//   ORIGINAL_BRANCH_RECEIVE  - origin branch       SENT_TO_ORIGINAL_BRANCH -> ORIGINAL_BRANCH_RECEIVED
//                              (terminal for serviceType=INVENTORY - releases the held ProductSerial back to AVAILABLE)
//   CUSTOMER_RECEIVE         - origin branch       ORIGINAL_BRANCH_RECEIVED -> SERVICE_COMPLETED
//                              (NEW_CUSTOMER/OUT_CUSTOMER only - see Service.modal.js's status-enum comment)
export const updateServiceStatusController = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  const rollback = async (message, statusCode = 400) => {
    await session.abortTransaction();
    session.endSession();
    return errorResponse(res, message, statusCode);
  };

  try {
    const { id } = req.params;
    const { action, notes, serviceVendorId, repairOutcome } = req.body;
    const user = req.user;

    if (!mongoose.Types.ObjectId.isValid(id)) return rollback("Invalid service id", 400);

    const service = await Service.findById(id).session(session);
    if (!service || service.isDeleted) return rollback("Service not found", 404);

    const isSuperAdmin = user.role === "SUPER_ADMIN";
    const isOriginBranchUser = !!user.branchId && user.branchId.toString() === service.originBranchId.toString();
    const isServiceBranchUser = !!user.branchId && user.branchId.toString() === service.serviceBranchId.toString();

    const requireOriginBranch = () => {
      if (!isSuperAdmin && !isOriginBranchUser) {
        throw { message: "Only the origin branch can perform this action", statusCode: 403 };
      }
    };
    const requireServiceBranch = () => {
      if (!isSuperAdmin && !isServiceBranchUser) {
        throw { message: "Only the Service branch can perform this action", statusCode: 403 };
      }
    };
    const requirePermissionGrant = () => {
      if (!isSuperAdmin && user.permissions?.["service.manage"] !== true) {
        throw { message: "You don't have permission to perform this action", statusCode: 403 };
      }
    };
    const requireStatus = (expected) => {
      if (service.status !== expected) {
        throw { message: `Only ${expected} services can do this. Current: ${service.status}`, statusCode: 400 };
      }
    };

    let fromStatus = service.status;
    let toStatus = service.status;
    let historyAction = "";
    let historyBranchId = null;
    let historyServiceVendorId = null;

    try {
      if (action === "SEND_TO_SERVICE_BRANCH") {
        requireOriginBranch();
        requirePermissionGrant();
        requireStatus("CUSTOMER_RECEIVED");
        toStatus = "SENT_TO_SERVICE_BRANCH";
        historyAction = "SENT_TO_SERVICE_BRANCH";
        historyBranchId = service.originBranchId;
        service.sentToServiceBranchBy = user._id;
        service.sentToServiceBranchByName = user.name;
        service.sentToServiceBranchAt = new Date();
      } else if (action === "SERVICE_BRANCH_RECEIVE") {
        requireServiceBranch();
        requirePermissionGrant();
        requireStatus("SENT_TO_SERVICE_BRANCH");
        toStatus = "SERVICE_BRANCH_RECEIVED";
        historyAction = "SERVICE_BRANCH_RECEIVED";
        historyBranchId = service.serviceBranchId;
        service.serviceBranchReceivedBy = user._id;
        service.serviceBranchReceivedByName = user.name;
        service.serviceBranchReceivedAt = new Date();
      } else if (action === "ALLOCATE_VENDOR") {
        requireServiceBranch();
        requirePermissionGrant();
        requireStatus("SERVICE_BRANCH_RECEIVED");
        if (!serviceVendorId || !mongoose.Types.ObjectId.isValid(serviceVendorId)) {
          throw { message: "A valid service vendor is required", statusCode: 400 };
        }
        const vendor = await ServiceVendor.findOne({ _id: serviceVendorId, isActive: true, isDeleted: false }).session(session);
        if (!vendor) throw { message: "Service vendor not found or inactive", statusCode: 404 };
        toStatus = "VENDOR_ALLOCATED";
        historyAction = "VENDOR_ALLOCATED";
        historyBranchId = service.serviceBranchId;
        historyServiceVendorId = vendor._id;
        service.serviceVendorId = vendor._id;
        service.allocatedBy = user._id;
        service.allocatedByName = user.name;
        service.allocatedAt = new Date();
      } else if (action === "START_PROCESSING") {
        requireServiceBranch();
        requirePermissionGrant();
        requireStatus("VENDOR_ALLOCATED");
        toStatus = "VENDOR_PROCESSING";
        historyAction = "VENDOR_PROCESSING_STARTED";
        historyBranchId = service.serviceBranchId;
        historyServiceVendorId = service.serviceVendorId;
        service.processingStartedBy = user._id;
        service.processingStartedByName = user.name;
        service.processingStartedAt = new Date();
      } else if (action === "VENDOR_RETURN") {
        requireServiceBranch();
        requirePermissionGrant();
        requireStatus("VENDOR_PROCESSING");
        // Two possible outcomes when the vendor hands the item(s) back
        // (spec: "1 product unable to repair, 2 product is repaired") -
        // both proceed through the same remaining steps (FINISHED ->
        // SEND_TO_ORIGINAL_BRANCH -> ...) to return the item(s), no
        // separate status path - only the recorded outcome + reason differ.
        if (!["REPAIRED", "UNABLE_TO_REPAIR"].includes(repairOutcome)) {
          throw { message: "repairOutcome must be REPAIRED or UNABLE_TO_REPAIR", statusCode: 400 };
        }
        if (repairOutcome === "UNABLE_TO_REPAIR" && !notes?.trim()) {
          throw { message: "A reason is required when the item could not be repaired", statusCode: 400 };
        }
        toStatus = "VENDOR_RETURNED";
        historyAction = "VENDOR_RETURNED";
        historyBranchId = service.serviceBranchId;
        historyServiceVendorId = service.serviceVendorId;
        service.repairOutcome = repairOutcome;
        service.repairOutcomeNotes = repairOutcome === "UNABLE_TO_REPAIR" ? notes.trim() : "";
        service.vendorReturnedBy = user._id;
        service.vendorReturnedByName = user.name;
        service.vendorReturnedAt = new Date();
      } else if (action === "MARK_FINISHED") {
        requireServiceBranch();
        requirePermissionGrant();
        requireStatus("VENDOR_RETURNED");
        toStatus = "FINISHED";
        historyAction = "FINISHED";
        historyBranchId = service.serviceBranchId;
        service.finishedBy = user._id;
        service.finishedByName = user.name;
        service.finishedAt = new Date();
      } else if (action === "SEND_TO_ORIGINAL_BRANCH") {
        requireServiceBranch();
        requirePermissionGrant();
        requireStatus("FINISHED");
        toStatus = "SENT_TO_ORIGINAL_BRANCH";
        historyAction = "SENT_TO_ORIGINAL_BRANCH";
        historyBranchId = service.serviceBranchId;
        service.sentToOriginalBranchBy = user._id;
        service.sentToOriginalBranchByName = user.name;
        service.sentToOriginalBranchAt = new Date();
      } else if (action === "ORIGINAL_BRANCH_RECEIVE") {
        requireOriginBranch();
        requirePermissionGrant();
        requireStatus("SENT_TO_ORIGINAL_BRANCH");
        toStatus = "ORIGINAL_BRANCH_RECEIVED";
        historyAction = "ORIGINAL_BRANCH_RECEIVED";
        historyBranchId = service.originBranchId;
        service.originalBranchReceivedBy = user._id;
        service.originalBranchReceivedByName = user.name;
        service.originalBranchReceivedAt = new Date();

        // INVENTORY has no customer at the end - the unit(s) are
        // simply back in stock, so this is its terminal transition.
        // Release the hold on every item row: IN_SERVICE -> AVAILABLE,
        // plus an offsetting SERVICE_RELEASE ledger entry per unit.
        await releaseInventoryHold(service, user, session);
      } else if (action === "CUSTOMER_RECEIVE") {
        requireOriginBranch();
        requirePermissionGrant();
        requireStatus("ORIGINAL_BRANCH_RECEIVED");
        if (service.serviceType === "INVENTORY") {
          throw { message: "INVENTORY services complete at Original Branch Received - there is no customer handover", statusCode: 400 };
        }
        toStatus = "SERVICE_COMPLETED";
        historyAction = "CUSTOMER_RECEIVED";
        historyBranchId = service.originBranchId;
        service.completedBy = user._id;
        service.completedByName = user.name;
        service.completedAt = new Date();
      } else {
        throw {
          message: `Invalid action: ${action}. Allowed: SEND_TO_SERVICE_BRANCH, SERVICE_BRANCH_RECEIVE, ALLOCATE_VENDOR, START_PROCESSING, VENDOR_RETURN, MARK_FINISHED, SEND_TO_ORIGINAL_BRANCH, ORIGINAL_BRANCH_RECEIVE, CUSTOMER_RECEIVE`,
          statusCode: 400,
        };
      }
    } catch (transitionError) {
      if (transitionError?.statusCode) {
        return rollback(transitionError.message, transitionError.statusCode);
      }
      throw transitionError;
    }

    service.status = toStatus;
    await service.save({ session });

    await ServiceHistory.logHistory({
      service,
      action: historyAction,
      fromStatus,
      toStatus,
      branchId: historyBranchId,
      serviceVendorId: historyServiceVendorId,
      notes:
        notes ||
        (action === "VENDOR_RETURN"
          ? `Vendor returned item(s) - ${repairOutcome === "REPAIRED" ? "repaired" : "unable to repair"}, by ${user.name}`
          : `Service ${historyAction.toLowerCase().replace(/_/g, " ")} by ${user.name}`),
      performedBy: user._id,
      performedByName: user.name,
      session,
    });

    // Origin branch === Service branch: "send back to original branch"
    // is physically meaningless (see services/service/sameBranchCascade.js) -
    // complete it automatically right here, still writing its own
    // history entries, so the ticket lands straight on
    // ORIGINAL_BRANCH_RECEIVED (or SERVICE_COMPLETED-ready) without a
    // separate manual click for a shipment that never happens.
    if (action === "MARK_FINISHED") {
      await cascadeReturnIfSameBranch(service, user, session);
    }

    await session.commitTransaction();
    session.endSession();

    const populatedService = await Service.findById(service._id)
      .populate("customerId", "name mobile email")
      .populate("items.productId", "name category modelNumber")
      .populate("items.productSerialId", "serialNumber status")
      .populate("originBranchId", "name code")
      .populate("serviceBranchId", "name code")
      .populate("serviceVendorId", "name phone email")
      .populate("createdBy", "name email");

    return successResponse(res, `Service updated successfully`, { service: populatedService });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Update Service Status Error:", error);
    return errorResponse(res, error.message || "Failed to update service status", 500);
  }
};
