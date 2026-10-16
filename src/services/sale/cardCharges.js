// services/sale/cardCharges.js
//
// Card convenience fee. A CARD payment row can carry `cardCharge` - the
// extra the customer pays on top for paying by card. It is NOT part of
// the products' price:
//   - Sale.totalAmount (and every P&L / GST / sales report built on it)
//     stays the products' total.
//   - paidAmount / pendingAmount / paymentStatus keep counting only each
//     row's `amount` against that total, so a fee never leaves a balance.
//   - Sale.convenienceFee = sum of the rows' cardCharge. What the customer
//     actually pays = totalAmount + convenienceFee (shown on the sale,
//     its invoice and the customer invoice link).

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The card charge a payment row may carry - always 0 for non-CARD rows. */
export const normalizeCardCharge = (payment) =>
    payment?.paymentMethod === "CARD" ? round2(Math.max(0, Number(payment.cardCharge) || 0)) : 0;

/** Returns an error message for a bad row, or null. */
export const validateCardCharge = (payment, index) => {
    const charge = Number(payment?.cardCharge) || 0;
    if (charge < 0) return `Payment ${index + 1}: card charges can't be negative`;
    if (charge > 0 && payment?.paymentMethod !== "CARD") return `Payment ${index + 1}: charges can only be added to a Card payment`;
    if (charge > 0 && !(Number(payment?.amount) > 0)) return `Payment ${index + 1}: enter the card amount before its charges`;
    return null;
};

export const sumConvenienceFee = (paymentDetails) =>
    round2((paymentDetails || []).reduce((sum, p) => sum + (Number(p.cardCharge) || 0), 0));
