// services/sale/customerShortLink.js
import crypto from "crypto";
import Sale from "../../models/Sale.modal.js";

// Short invoice links for Sale Detail's "Copy Message". A short code is
// only ever a pointer to ONE sale (Sale.customerShortCode); it is
// resolved to that sale's CURRENT customerAccessToken on every open, so
// it can never reach anything the full invoice link couldn't - a
// deleted sale or a cleared token kills both. There is no stored
// destination URL at all, so nothing here can be turned into a
// redirect to somewhere else.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
// 10 base62 characters = ~59.5 bits - unguessable at the rate the
// public resolve endpoint allows (see publicCustomerAccess.router.js).
export const SHORT_CODE_LENGTH = 10;
const MAX_ATTEMPTS = 5;
const SHORT_CODE_PATTERN = new RegExp(`^[A-Za-z0-9]{${SHORT_CODE_LENGTH}}$`);

export const isWellFormedShortCode = (code) => typeof code === "string" && SHORT_CODE_PATTERN.test(code);

// Rejection sampling (bytes >= 248 are dropped) so every character is
// equally likely - a plain `byte % 62` would favour the first eight.
export const generateShortCode = () => {
    let code = "";
    while (code.length < SHORT_CODE_LENGTH) {
        for (const byte of crypto.randomBytes(SHORT_CODE_LENGTH * 2)) {
            if (byte < 248 && code.length < SHORT_CODE_LENGTH) code += ALPHABET[byte % 62];
        }
    }
    return code;
};

export class ShortLinkError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/**
 * The sale's short code, created on first use and reused after that.
 * Safe under concurrent calls: the code is only written while the sale
 * still has none, so parallel requests all end up returning the one
 * that won. A collision with another sale's code fails on the unique
 * index and is retried with a fresh code. `generate` is injectable for
 * the collision test only.
 */
export const getOrCreateSaleShortCode = async (saleId, generate = generateShortCode) => {
    // One more read than writes, so the last write is always read back.
    for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
        const sale = await Sale.findOne({ _id: saleId, isDeleted: false })
            .select("customerAccessToken customerShortCode")
            .lean();
        if (!sale) throw new ShortLinkError("Sale not found", 404);
        if (!sale.customerAccessToken) {
            throw new ShortLinkError("This sale has no customer invoice link yet - generate the invoice first.", 400);
        }
        if (sale.customerShortCode) return sale.customerShortCode;
        if (attempt === MAX_ATTEMPTS) break;

        try {
            // timestamps: false - a share link is not an edit to the sale.
            await Sale.updateOne(
                { _id: saleId, isDeleted: false, customerAccessToken: { $type: "string" }, customerShortCode: null },
                { $set: { customerShortCode: generate() } },
                { timestamps: false }
            );
        } catch (error) {
            if (error?.code !== 11000) throw error;
            // Another sale already has this code - loop and try a new one.
        }
        // Re-read either way: our write, a parallel request's write, or
        // (after a collision) nothing yet.
    }
    throw new ShortLinkError("Could not create a short invoice link - please try again.", 503);
};

/** The customer token a short code currently stands for, or null. */
export const resolveShortCodeToToken = async (code) => {
    if (!isWellFormedShortCode(code)) return null;
    const sale = await Sale.findOne({ customerShortCode: code, isDeleted: false })
        .select("customerAccessToken")
        .lean();
    return sale?.customerAccessToken || null;
};
