// controllers/service/lookupServiceableUnitBySerial.controller.js
import ProductSerial from "../../models/ProductSerial.modal.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// "Type the serial number, fetch the unit's details" for the Create
// Service screen's INVENTORY item rows - the reverse lookup of
// getServiceableUnits.controller.js (which goes product -> list of
// serials). Auto-fills product name/model number/condition
// description; issueDescription is never fetched here, it's always
// typed by the user (see InventoryItemsTable.jsx).
export const lookupServiceableUnitBySerialController = async (req, res) => {
  try {
    const { serialNumber } = req.query;
    const { branchId } = req.query;

    if (!serialNumber?.trim()) return errorResponse(res, "Serial number is required", 400);
    if (!branchId) return errorResponse(res, "Branch ID is required", 400);
    const { error: branchError } = await resolveActiveBranch(branchId);
    if (branchError) return errorResponse(res, `Branch: ${branchError}`, 400);

    // ProductSerial.serialNumber is stored uppercase (schema-level
    // `uppercase: true` setter) - match case-insensitively regardless
    // of how the user typed it.
    const serial = await ProductSerial.findOne({
      serialNumber: serialNumber.trim().toUpperCase(),
      isDeleted: false,
    })
      .populate("productId", "name category modelNumber isSerialized")
      .lean();

    if (!serial) return errorResponse(res, "No unit found with this serial number", 404);
    if (!serial.productId?.isSerialized) return errorResponse(res, "This product is not serialized", 400);
    if (serial.status !== "AVAILABLE") {
      return errorResponse(res, `This unit is currently ${serial.status}, not AVAILABLE`, 400);
    }
    if (!serial.currentBranchId || serial.currentBranchId.toString() !== branchId) {
      return errorResponse(res, "This unit is not AVAILABLE at the selected branch", 400);
    }

    return successResponse(res, "Unit found", {
      productSerialId: serial._id,
      serialNumber: serial.serialNumber,
      productId: serial.productId._id,
      productName: serial.productId.name,
      category: serial.productId.category,
      modelNumber: serial.productId.modelNumber || "",
      description: serial.description || { main: "", second: "" },
      purchaseId: serial.purchaseId,
    });
  } catch (error) {
    console.error("Lookup Serviceable Unit By Serial Error:", error);
    return errorResponse(res, "Failed to look up unit", 500);
  }
};
