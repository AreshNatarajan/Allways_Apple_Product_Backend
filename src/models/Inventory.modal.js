// models/Inventory.modal.js
import mongoose from "mongoose";

const inventorySchema = new mongoose.Schema(
  {
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    // ✅ Total quantity (all batches combined)
    quantity: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

// ✅ Unique index
inventorySchema.index(
  {
    branchId: 1,
    productId: 1,
  },
  {
    unique: true,
  }
);

const Inventory = mongoose.model("Inventory", inventorySchema);

export default Inventory;

