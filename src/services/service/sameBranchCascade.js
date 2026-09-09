// services/service/sameBranchCascade.js
import ServiceHistory from "../../models/ServiceHistory.modal.js";
import { releaseInventoryHold } from "./releaseInventoryHold.js";

// When a Service's origin branch IS the Service branch (e.g. the
// Service branch itself creates a ticket, or handles a Chennai-direct-
// acquisition unit), the "send it to the Service branch" / "send it
// back to the origin branch" steps are physically meaningless - there
// is nothing to actually ship. Rather than making staff click through
// two no-op confirmations for a move that never happens, these two
// pairs of transitions are completed automatically the moment they
// become reachable, still writing one ServiceHistory entry per step
// (never skipped from the audit trail - just not a manual action) so
// the timeline stays complete and every stage remains visible.
//
// This intentionally departs from "do not skip statuses" only in the
// sense that no separate button-click is required per hop - every
// status in the lifecycle is still entered and still recorded.

// CUSTOMER_RECEIVED -> SENT_TO_SERVICE_BRANCH -> SERVICE_BRANCH_RECEIVED,
// run immediately after a Service is created, so origin===service-branch
// tickets land straight on SERVICE_BRANCH_RECEIVED - ready for
// ALLOCATE_VENDOR right away.
export const cascadeIntakeIfSameBranch = async (service, user, session) => {
  if (service.originBranchId.toString() !== service.serviceBranchId.toString()) return;

  service.status = "SENT_TO_SERVICE_BRANCH";
  service.sentToServiceBranchBy = user._id;
  service.sentToServiceBranchByName = user.name;
  service.sentToServiceBranchAt = new Date();
  await service.save({ session });
  await ServiceHistory.logHistory({
    service,
    action: "SENT_TO_SERVICE_BRANCH",
    fromStatus: "CUSTOMER_RECEIVED",
    toStatus: "SENT_TO_SERVICE_BRANCH",
    branchId: service.originBranchId,
    notes: "Origin branch is the Service branch - sent automatically, nothing to physically ship",
    performedBy: user._id,
    performedByName: user.name,
    session,
  });

  service.status = "SERVICE_BRANCH_RECEIVED";
  service.serviceBranchReceivedBy = user._id;
  service.serviceBranchReceivedByName = user.name;
  service.serviceBranchReceivedAt = new Date();
  await service.save({ session });
  await ServiceHistory.logHistory({
    service,
    action: "SERVICE_BRANCH_RECEIVED",
    fromStatus: "SENT_TO_SERVICE_BRANCH",
    toStatus: "SERVICE_BRANCH_RECEIVED",
    branchId: service.serviceBranchId,
    notes: "Origin branch is the Service branch - received automatically, nothing to physically ship",
    performedBy: user._id,
    performedByName: user.name,
    session,
  });
};

// FINISHED -> SENT_TO_ORIGINAL_BRANCH -> ORIGINAL_BRANCH_RECEIVED, run
// immediately after MARK_FINISHED for an origin===service-branch
// ticket, landing on ORIGINAL_BRANCH_RECEIVED - ready for
// CUSTOMER_RECEIVE (or already terminal for INVENTORY) right away.
export const cascadeReturnIfSameBranch = async (service, user, session) => {
  if (service.originBranchId.toString() !== service.serviceBranchId.toString()) return;

  service.status = "SENT_TO_ORIGINAL_BRANCH";
  service.sentToOriginalBranchBy = user._id;
  service.sentToOriginalBranchByName = user.name;
  service.sentToOriginalBranchAt = new Date();
  await service.save({ session });
  await ServiceHistory.logHistory({
    service,
    action: "SENT_TO_ORIGINAL_BRANCH",
    fromStatus: "FINISHED",
    toStatus: "SENT_TO_ORIGINAL_BRANCH",
    branchId: service.serviceBranchId,
    notes: "Service branch is the origin branch - sent automatically, nothing to physically ship",
    performedBy: user._id,
    performedByName: user.name,
    session,
  });

  service.status = "ORIGINAL_BRANCH_RECEIVED";
  service.originalBranchReceivedBy = user._id;
  service.originalBranchReceivedByName = user.name;
  service.originalBranchReceivedAt = new Date();
  await service.save({ session });
  await ServiceHistory.logHistory({
    service,
    action: "ORIGINAL_BRANCH_RECEIVED",
    fromStatus: "SENT_TO_ORIGINAL_BRANCH",
    toStatus: "ORIGINAL_BRANCH_RECEIVED",
    branchId: service.originBranchId,
    notes: "Service branch is the origin branch - received automatically, nothing to physically ship",
    performedBy: user._id,
    performedByName: user.name,
    session,
  });

  // Same release-on-arrival rule as the manual ORIGINAL_BRANCH_RECEIVE
  // action - INVENTORY units must be freed back to AVAILABLE the moment
  // the service reaches this status, cascade or not.
  await releaseInventoryHold(service, user, session);
};
