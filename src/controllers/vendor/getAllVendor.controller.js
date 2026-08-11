import Vendor from "../../models/Vendor.modal.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

export const getAllVendorController = async (
  req,
  res
) => {

  try {

    const vendors =
      await Vendor.find({

        isDeleted: false,

      })
        .populate(
          "createdBy",
          "name email role"
        )
        .sort({
          createdAt: -1,
        });

    return successResponse(
      res,
      "Vendors retrieved successfully",
      vendors
    );

  } catch (error) {

    console.error(
      "Get Vendors Error:",
      error
    );

    return errorResponse(
      res,
      "Error retrieving vendors",
      500
    );

  }

};

