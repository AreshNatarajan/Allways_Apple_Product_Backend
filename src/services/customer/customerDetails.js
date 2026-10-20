// services/customer/customerDetails.js
//
// Validates and applies a correction to a customer's contact details
// (name / mobile / email / address) - the same format and per-branch
// uniqueness rules updateCustomer.Controller.js enforces - for flows that
// edit a customer from elsewhere (e.g. a sale's trade-in edit). Mutates
// the passed Customer document in memory and returns the list of changes;
// the caller saves it inside its own transaction.

import Customer from "../../models/Customer.modal.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\d{7,15}$/;

const validationError = (message, statusCode = 400) => {
    const err = new Error(message);
    err.isValidation = true;
    err.statusCode = statusCode;
    return err;
};

const LABELS = { name: "Customer name", mobile: "Customer mobile", email: "Customer email", address: "Customer address" };

/**
 * input: { name?, mobile?, email?, address? } - omitted fields are left
 * unchanged. Throws a validation error (err.isValidation) when invalid.
 * Returns [{ field, label, oldValue, newValue }] for what actually changed.
 */
export const applyCustomerDetails = async (customer, input, session) => {
    const next = {
        name: input?.name !== undefined ? String(input.name).trim() : customer.name || "",
        mobile: input?.mobile !== undefined ? String(input.mobile).trim() : customer.mobile || "",
        email: input?.email !== undefined ? String(input.email).trim().toLowerCase() : customer.email || "",
        address: input?.address !== undefined ? String(input.address).trim() : customer.address || "",
    };

    if (!next.name) throw validationError("Customer name is required");
    if (next.mobile && !PHONE_REGEX.test(next.mobile)) throw validationError("Invalid phone number");
    if (next.email && !EMAIL_REGEX.test(next.email)) throw validationError("Invalid email format");

    if (next.mobile && next.mobile !== (customer.mobile || "")) {
        const dupe = await Customer.findOne({ _id: { $ne: customer._id }, branchId: customer.branchId, mobile: next.mobile, isDeleted: false }).session(session);
        if (dupe) throw validationError(`A customer with phone "${next.mobile}" already exists in this branch`, 409);
    }
    if (next.email && next.email !== (customer.email || "")) {
        const dupe = await Customer.findOne({ _id: { $ne: customer._id }, branchId: customer.branchId, email: next.email, isDeleted: false }).session(session);
        if (dupe) throw validationError(`A customer with email "${next.email}" already exists in this branch`, 409);
    }

    const changes = [];
    for (const field of ["name", "mobile", "email", "address"]) {
        const oldValue = customer[field] || "";
        if (next[field] !== oldValue) {
            changes.push({ field: `customer.${field}`, label: LABELS[field], oldValue, newValue: next[field] });
            customer[field] = next[field];
        }
    }
    return changes;
};
