// services/service/releaseInventoryHold.js
import ProductSerial from "../../models/ProductSerial.modal.js";
import { recordStockMovement } from "../purchase/recordStockMovement.js";

// Releases every held INVENTORY-type item on a Service back to
// AVAILABLE stock (IN_SERVICE -> AVAILABLE), with an offsetting
// SERVICE_RELEASE ledger entry per unit. Shared by both the manual
// ORIGINAL_BRANCH_RECEIVE action and the automatic same-branch return
// cascade (sameBranchCascade.js) - the release must happen exactly
// once, the moment the service reaches ORIGINAL_BRANCH_RECEIVED,
// regardless of which path got it there.
export const releaseInventoryHold = async (service, user, session) => {
  if (service.serviceType !== "INVENTORY") return;

  for (const item of service.items) {
    if (!item.productSerialId) continue;
    const serial = await ProductSerial.findById(item.productSerialId).session(session);
    if (serial && serial.status === "IN_SERVICE") {
      serial.status = "AVAILABLE";
      serial.currentBranchId = service.originBranchId;
      await serial.save({ session });

      await recordStockMovement({
        type: "SERVICE_RELEASE",
        productId: serial.productId,
        branchId: service.originBranchId,
        serialId: serial._id,
        quantityDelta: 1,
        unitCost: serial.purchasePrice,
        gstApplicable: serial.gstApplicable,
        gstPercent: serial.purchaseGstPercent,
        referenceType: "Service",
        referenceId: service._id,
        performedBy: user._id,
        performedByName: user.name || "",
        notes: `Serial ${serial.serialNumber} released from service ${service.serviceNumber}`,
        session,
      });
    }
  }
};
