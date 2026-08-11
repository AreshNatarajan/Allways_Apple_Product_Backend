// controllers/branch/getBranches.controller.js

import Branch from "../../models/Branch.modal.js";

import { successResponse, errorResponse } from "../../utils/responseHandler.js";

export const getAllBranchesController = async (req, res) => {
  try {
    const authenticatedUser = req.user;

    const { search = "", includeInactive } = req.query;

    const filter = {
      isDeleted: false,
    };

    // Everyone gets active-only branches by default. Only SUPER_ADMIN
    // can opt into seeing deactivated branches too (needed to find one
    // worth reactivating - there is no other way to discover a
    // deactivated branch's id via listing).
    if (!(includeInactive === "true" && authenticatedUser?.role === "SUPER_ADMIN")) {
      filter.isActive = true;
    }

    if (search?.trim()) {
      filter.$or = [
        {
          name: {
            $regex: search.trim(),
            $options: "i",
          },
        },
        {
          code: {
            $regex: search.trim(),
            $options: "i",
          },
        },
      ];
    }

    const branches = await Branch.find(filter)

      .select("_id name code address phones")

      .sort({
        name: 1,
      });

    return successResponse(res, "Branches retrieved successfully", branches);
  } catch (error) {
    console.error("Get Branches Error:", error);

    return errorResponse(res, "Failed to retrieve branches", 500);
  }
};
