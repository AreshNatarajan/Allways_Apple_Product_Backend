import Inventory from "../models/Inventory.modal.js";

/**
 * Increase Stock
 */
export const increaseStock = async ({
  productId,
  branchId,
  quantity,
}) => {
  try {

    let inventory =
      await Inventory.findOne({
        productId,
        branchId,
      });

    if (inventory) {

      inventory.quantity += quantity;

    } else {

      inventory =
        await Inventory.create({

          productId,

          branchId,

          quantity,

        });

    }

    await inventory.save();

    return inventory;

  } catch (error) {

    console.error(
      "Increase Stock Error:",
      error
    );

    throw error;
  }
};

/**
 * Decrease Stock
 */
export const decreaseStock = async ({
  productId,
  branchId,
  quantity,
}) => {

  const inventory =
    await Inventory.findOne({
      productId,
      branchId,
    });

  if (!inventory) {
    throw new Error(
      "Inventory not found"
    );
  }

  if (
    inventory.quantity < quantity
  ) {
    throw new Error(
      "Insufficient stock"
    );
  }

  inventory.quantity -= quantity;

  await inventory.save();

  return inventory;
};

/**
 * Get Stock
 */
export const getStock = async ({
  productId,
  branchId,
}) => {

  const inventory =
    await Inventory.findOne({
      productId,
      branchId,
    });

  return inventory
    ? inventory.quantity
    : 0;
};