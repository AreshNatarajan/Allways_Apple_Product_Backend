// services/service/normalizeLegacyServiceItems.js
import Product from "../../models/Product.modal.js";

// Tickets created before Service supported several items per ticket
// stored ONE product directly on the document (productId,
// productSerialId, serialNumberText, issueDescription, acquisitionSource,
// acquisitionPurchaseId) and have no items[] at all - e.g.
// SRV-202609-0003. The list/detail pages only read items[], so those
// tickets showed "Items (0)" / "-".
//
// Read-time only: builds the equivalent single items[] row on the
// already-loaded (lean) documents. The stored record is never modified.
// `productId` is populated the same way the normal query populates
// items.productId, so the frontend needs no special case.
export const normalizeLegacyServiceItems = async (services) => {
  const list = (Array.isArray(services) ? services : [services]).filter(Boolean);
  const legacy = list.filter((s) => (!Array.isArray(s.items) || s.items.length === 0) && s.productId);
  if (legacy.length === 0) return services;

  const products = await Product.find({ _id: { $in: legacy.map((s) => s.productId) } })
    .select("name category modelNumber")
    .lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  for (const s of legacy) {
    const product = byId.get(String(s.productId)) || null;
    s.items = [
      {
        productId: product,
        productName: product?.name || "",
        productSerialId: s.productSerialId || null,
        serialNumberText: s.serialNumberText || "",
        description: { main: "", second: "" },
        images: [],
        issueDescription: s.issueDescription || "",
        acquisitionSource: s.acquisitionSource || "CUSTOMER_INTAKE",
        acquisitionPurchaseId: s.acquisitionPurchaseId || null,
      },
    ];
    s.legacyFormat = true;
  }
  return services;
};
