// controllers/service/checkServiceSerial.controller.js
import Service from "../../models/Service.modal.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Live "is this serial already open elsewhere" check for the Create
// Service screen's customer-owned item rows (serialNumberText - see
// CustomerItemsTable.jsx) - lets staff see the conflict while typing
// instead of only finding out at submit time. Mirrors exactly the same
// case-insensitive, not-yet-completed query createService.controller.js
// itself enforces on submit, so a serial that passes here is guaranteed
// to also pass then (barring a race with another submit in between).
// Global, not branch-scoped - a physical device can only be in one
// place regardless of which branch is asking.
export const checkServiceSerialController = async (req, res) => {
  try {
    const { serialNumberText } = req.query;
    const serialText = serialNumberText?.trim() || "";
    if (!serialText) return errorResponse(res, "Serial number is required", 400);

    const activeDuplicate = await Service.findOne({
      isDeleted: false,
      status: { $ne: "SERVICE_COMPLETED" },
      items: { $elemMatch: { serialNumberText: new RegExp(`^${escapeRegex(serialText)}$`, "i") } },
    })
      .select("serviceNumber")
      .lean();

    if (activeDuplicate) {
      return successResponse(res, "Serial already on an open service", {
        available: false,
        serviceNumber: activeDuplicate.serviceNumber,
      });
    }

    return successResponse(res, "Serial is available", { available: true, serviceNumber: null });
  } catch (error) {
    console.error("Check Service Serial Error:", error);
    return errorResponse(res, "Failed to check serial number", 500);
  }
};
