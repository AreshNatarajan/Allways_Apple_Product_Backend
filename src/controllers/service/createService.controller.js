// controllers/service/createService.controller.js
import mongoose from "mongoose";
import Service from "../../models/Service.modal.js";
import ServiceHistory from "../../models/ServiceHistory.modal.js";
import Customer from "../../models/Customer.modal.js";
import Product from "../../models/Product.modal.js";
import ProductSerial from "../../models/ProductSerial.modal.js";
import Purchase from "../../models/Purchase.modal.js";
import Branch from "../../models/Branch.modal.js";
import { resolveActiveBranch } from "../../services/branchValidation.service.js";
import { generateDocumentNumber } from "../../services/documentNumber.service.js";
import { getOrCreateGstConfig } from "../../services/gstConfig/getOrCreateGstConfig.js";
import { recordStockMovement } from "../../services/purchase/recordStockMovement.js";
import { cascadeIntakeIfSameBranch } from "../../services/service/sameBranchCascade.js";
import { successResponse, errorResponse } from "../../utils/responseHandler.js";

// ============================================================
// CREATE SERVICE
// ============================================================
// serviceType decides where the customer/product data comes from, and
// is shared by every item[] row on the ticket (never mixed):
//  - NEW_CUSTOMER: customer has no existing Customer record yet - one
//    is created inline (branch-scoped, same as every other Customer).
//  - OUT_CUSTOMER: an existing Customer record is selected.
//  - INVENTORY: our own branch stock - each row is a real AVAILABLE
//    ProductSerial at the acting branch, flipped to IN_SERVICE right
//    here (so it can never be picked into a Sale/Transfer while under
//    service - spec section 14), with a SERVICE_HOLD StockMovement
//    recorded per unit.
//
// A ticket carries one or more items[] rows (mirrors Transfer's
// items[] pattern) - "product will be dynamic" per the UI request.
//
// The Chennai-direct-acquisition case (spec section 5/16) is just an
// INVENTORY row with an optional acquisitionPurchaseId: the staff
// member already completed a completely ordinary, unmodified
// direct-receive Purchase at the Service branch to obtain the unit;
// this controller only reads that Purchase's resulting ProductSerial
// and stamps the link - it never creates a Transfer, and it never
// mutates the Purchase itself.
export const createServiceController = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  const rollback = async (message, statusCode = 400) => {
    await session.abortTransaction();
    session.endSession();
    return errorResponse(res, message, statusCode);
  };

  try {
    const user = req.user;
    const isSuperAdmin = user.role === "SUPER_ADMIN";
    let {
      serviceType,
      originBranchId,
      items,
      notes,
      customerId,
      customer, // { name, mobile, email, address } - NEW_CUSTOMER only
    } = req.body;

    if (!isSuperAdmin) {
      if (!user.branchId) return rollback("Branch not assigned to user", 400);
      if (user.permissions?.["service.create"] !== true) {
        return rollback("You don't have permission to perform this action", 403);
      }
      originBranchId = user.branchId.toString();
    }

    if (!["NEW_CUSTOMER", "OUT_CUSTOMER", "INVENTORY"].includes(serviceType)) {
      return rollback("A valid serviceType (NEW_CUSTOMER, OUT_CUSTOMER, INVENTORY) is required", 400);
    }
    if (!originBranchId) return rollback("Origin branch is required", 400);
    if (!Array.isArray(items) || items.length === 0) {
      return rollback("At least one item is required", 400);
    }

    const { error: originError, branch: originBranch } = await resolveActiveBranch(originBranchId);
    if (originError) return rollback(`Origin branch: ${originError}`, 400);

    const serviceBranch = await Branch.findOne({ isServiceBranch: true, isActive: true, isDeleted: false }).session(session);
    if (!serviceBranch) {
      return rollback("No central Service branch is configured. Ask a Super Admin to mark one branch as the Service branch.", 400);
    }

    // ============================================================
    // CUSTOMER RESOLUTION
    // ============================================================
    let resolvedCustomerId = null;
    let customerSnapshot = { name: "", mobile: "", email: "" };

    if (serviceType === "NEW_CUSTOMER") {
      if (!customer?.name?.trim()) return rollback("Customer name is required", 400);
      const [createdCustomer] = await Customer.create(
        [
          {
            branchId: originBranchId,
            name: customer.name.trim(),
            mobile: customer.mobile?.trim() || "",
            email: customer.email?.trim() || "",
            address: customer.address?.trim() || "",
            createdBy: user._id,
            createdByRole: user.role,
          },
        ],
        { session }
      );
      resolvedCustomerId = createdCustomer._id;
      customerSnapshot = { name: createdCustomer.name, mobile: createdCustomer.mobile, email: createdCustomer.email };
    } else if (serviceType === "OUT_CUSTOMER") {
      if (!customerId || !mongoose.Types.ObjectId.isValid(customerId)) {
        return rollback("A valid existing customer is required", 400);
      }
      const existingCustomer = await Customer.findOne({ _id: customerId, isDeleted: false }).session(session);
      if (!existingCustomer) return rollback("Customer not found", 404);
      resolvedCustomerId = existingCustomer._id;
      customerSnapshot = { name: existingCustomer.name, mobile: existingCustomer.mobile, email: existingCustomer.email };
    }

    // ============================================================
    // ITEM ROWS - validation + resolution only. The actual
    // ProductSerial status flip + StockMovement happen after the
    // Service document exists, below, so StockMovement.referenceId can
    // correctly point at it.
    // ============================================================
    const processedItems = [];
    const serialsToHold = []; // [{ serial, acquisitionPurchaseId }]
    const errors = [];

    for (let i = 0; i < items.length; i++) {
      const row = items[i] || {};
      const rowLabel = `Item ${i + 1}`;

      if (!row.productId || !mongoose.Types.ObjectId.isValid(row.productId)) {
        errors.push(`${rowLabel}: a valid Product is required`);
        continue;
      }
      const product = await Product.findOne({ _id: row.productId, isDeleted: false }).session(session).lean();
      if (!product) {
        errors.push(`${rowLabel}: product not found`);
        continue;
      }

      if (serviceType === "INVENTORY") {
        if (!row.productSerialId || !mongoose.Types.ObjectId.isValid(row.productSerialId)) {
          errors.push(`${rowLabel} (${product.name}): a valid inventory unit is required`);
          continue;
        }
        const serial = await ProductSerial.findOne({ _id: row.productSerialId, isDeleted: false }).session(session);
        if (!serial) {
          errors.push(`${rowLabel} (${product.name}): inventory unit not found`);
          continue;
        }
        if (serial.productId.toString() !== row.productId.toString()) {
          errors.push(`${rowLabel} (${product.name}): selected unit does not belong to the selected product`);
          continue;
        }
        if (serial.status !== "AVAILABLE" || !serial.currentBranchId || serial.currentBranchId.toString() !== originBranchId.toString()) {
          errors.push(`${rowLabel} (${product.name}): unit ${serial.serialNumber} is not AVAILABLE at ${originBranch.name}`);
          continue;
        }
        if (serialsToHold.some((s) => s.serial._id.toString() === serial._id.toString())) {
          errors.push(`${rowLabel} (${product.name}): unit ${serial.serialNumber} was already selected in another row`);
          continue;
        }

        let acquisitionSource = "EXISTING_INVENTORY";
        let resolvedAcquisitionPurchaseId = null;
        if (row.acquisitionPurchaseId) {
          if (!mongoose.Types.ObjectId.isValid(row.acquisitionPurchaseId)) {
            errors.push(`${rowLabel} (${product.name}): invalid acquisition purchase reference`);
            continue;
          }
          const purchase = await Purchase.findOne({ _id: row.acquisitionPurchaseId, isDeleted: false }).session(session).lean();
          if (!purchase) {
            errors.push(`${rowLabel} (${product.name}): acquisition purchase not found`);
            continue;
          }
          if (serial.purchaseId.toString() !== row.acquisitionPurchaseId.toString()) {
            errors.push(`${rowLabel} (${product.name}): unit was not acquired through the given purchase`);
            continue;
          }
          acquisitionSource = "DIRECT_SERVICE_PURCHASE";
          resolvedAcquisitionPurchaseId = purchase._id;
        }

        serialsToHold.push({ serial, acquisitionPurchaseId: resolvedAcquisitionPurchaseId });
        processedItems.push({
          productId: row.productId,
          productName: product.name,
          productSerialId: serial._id,
          serialNumberText: "",
          description: { main: "", second: "" },
          images: [],
          issueDescription: row.issueDescription?.trim() || "",
          acquisitionSource,
          acquisitionPurchaseId: resolvedAcquisitionPurchaseId,
        });
      } else {
        // NEW_CUSTOMER / OUT_CUSTOMER - customer-owned item, never
        // linked to a real ProductSerial (spec section 15).
        processedItems.push({
          productId: row.productId,
          productName: product.name,
          productSerialId: null,
          serialNumberText: row.serialNumberText?.trim() || "",
          description: { main: row.description?.main?.trim() || "", second: row.description?.second?.trim() || "" },
          images: Array.isArray(row.images) ? row.images.filter((img) => img?.url && img?.key) : [],
          issueDescription: row.issueDescription?.trim() || "",
          acquisitionSource: "CUSTOMER_INTAKE",
          acquisitionPurchaseId: null,
        });
      }
    }

    if (errors.length > 0) {
      return rollback(errors.join("\n"), 400);
    }

    // ============================================================
    // CREATE SERVICE
    // ============================================================
    const gstConfigForNumber = await getOrCreateGstConfig({ session });
    const serviceNumber = await generateDocumentNumber("service", gstConfigForNumber.documentPrefixes.service, { session });

    const [service] = await Service.create(
      [
        {
          serviceNumber,
          serviceType,
          customerId: resolvedCustomerId,
          customerSnapshot,
          items: processedItems,
          originBranchId,
          originBranchName: originBranch.name,
          serviceBranchId: serviceBranch._id,
          serviceBranchName: serviceBranch.name,
          status: "CUSTOMER_RECEIVED",
          notes: notes?.trim() || "",
          createdBy: user._id,
          createdByName: user.name,
        },
      ],
      { session }
    );

    // Hold every INVENTORY unit for service now that the Service
    // document exists - each must never be pickable into a Sale/
    // Transfer while a service is in progress (spec section 14).
    for (const { serial } of serialsToHold) {
      serial.status = "IN_SERVICE";
      await serial.save({ session });

      await recordStockMovement({
        type: "SERVICE_HOLD",
        productId: serial.productId,
        branchId: originBranchId,
        serialId: serial._id,
        quantityDelta: -1,
        unitCost: serial.purchasePrice,
        gstApplicable: serial.gstApplicable,
        gstPercent: serial.purchaseGstPercent,
        referenceType: "Service",
        referenceId: service._id,
        performedBy: user._id,
        performedByName: user.name || "",
        notes: `Serial ${serial.serialNumber} held for service ${service.serviceNumber}`,
        session,
      });
    }

    await ServiceHistory.logHistory({
      service,
      action: "CREATED",
      fromStatus: null,
      toStatus: "CUSTOMER_RECEIVED",
      branchId: originBranchId,
      notes: `Service created by ${user.name} - ${processedItems.length} item(s)`,
      performedBy: user._id,
      performedByName: user.name,
      session,
    });

    // Origin branch === Service branch: "send it to the Service
    // branch" is physically meaningless (see
    // services/service/sameBranchCascade.js) - complete it
    // automatically right here, still writing its own history entries,
    // so the ticket lands straight on SERVICE_BRANCH_RECEIVED and
    // ALLOCATE_VENDOR is available immediately, no separate manual
    // click for a shipment that never happens.
    await cascadeIntakeIfSameBranch(service, user, session);

    await session.commitTransaction();
    session.endSession();

    const populatedService = await Service.findById(service._id)
      .populate("customerId", "name mobile email")
      .populate("items.productId", "name category modelNumber")
      .populate("items.productSerialId", "serialNumber")
      .populate("originBranchId", "name code")
      .populate("serviceBranchId", "name code")
      .populate("createdBy", "name email");

    return successResponse(res, "Service created successfully", { service: populatedService });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("Create Service Error:", error);
    return errorResponse(res, error.message || "Failed to create service", 500);
  }
};
