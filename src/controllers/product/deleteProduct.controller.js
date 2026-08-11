import mongoose from "mongoose";
import Product from "../../models/Product.modal.js";

import {
  successResponse,
  errorResponse,
} from "../../utils/responseHandler.js";

export const deleteProductController = async (
  req,
  res
) => {

  try {

    const { id } = req.params;

    if (!id) {

      return errorResponse(
        res,
        "Product ID is required",
        400
      );

    }

    if (!mongoose.Types.ObjectId.isValid(id)) {

      return errorResponse(
        res,
        "Invalid product ID",
        400
      );

    }

    const product =
      await Product.findOne({

        _id: id,

        isDeleted: false,

      });

    if (!product) {

      return errorResponse(
        res,
        "Product not found",
        404
      );

    }

    // Soft Delete
    product.isActive = false;
    product.isDeleted = true;
    product.deletedAt = new Date();

    // Audit Fields
    product.updatedBy =
      req.user._id;

    product.updatedByRole =
      req.user.role;

    // Only revalidate the fields actually touched above - this
    // deactivate-only save must not be blocked by hsnCode/modelNumbers/
    // productCode validation on legacy documents that predate the
    // current-mandatory-HSN rule and were never being edited here.
    await product.save({ validateModifiedOnly: true });

    return successResponse(
      res,
      "Product deleted successfully",
      product
    );

  } catch (error) {

    console.error(
      "Error deleting product:",
      error
    );

    return errorResponse(
      res,
      "Internal server error",
      500
    );

  }

};


