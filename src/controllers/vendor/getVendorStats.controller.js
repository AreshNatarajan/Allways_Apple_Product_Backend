import Vendor from "../../models/Vendor.modal.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

/**
 * GET VENDOR STATS
 */
export const getVendorStatsController = async (
  req,
  res
) => {

  try {

    const stats =
      await Vendor.aggregate([
        {
          $match: {
            isDeleted: false,
          },
        },
        {
          $group: {
            _id: null,

            totalVendors: {
              $sum: 1,
            },

            activeVendors: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      "$isActive",
                      true,
                    ],
                  },
                  1,
                  0,
                ],
              },
            },

            inactiveVendors: {
              $sum: {
                $cond: [
                  {
                    $eq: [
                      "$isActive",
                      false,
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]);

    const result =
      stats[0] || {

        totalVendors: 0,

        activeVendors: 0,

        inactiveVendors: 0,

      };

    return successResponse(
      res,
      "Vendor stats retrieved successfully",
      result
    );

  } catch (error) {

    console.error(
      "Get Vendor Stats Error:",
      error
    );

    return errorResponse(
      res,
      "Error retrieving vendor stats",
      500
    );

  }

};

