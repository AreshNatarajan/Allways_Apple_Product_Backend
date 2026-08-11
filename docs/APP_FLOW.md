# App Flow — Living Reference

This file tracks **how the app actually behaves end-to-end**, flow by flow, as it's built. It is not an API list (see `docs/*_POSTMAN_TEST.md` + `docs/*_POSTMAN_COLLECTION.json` for that, one pair per feature). Update this file whenever a flow changes, a gap gets closed, or a new flow ships. Keep the Status Summary current — that's the part worth reading first in a new session.

---

## Status Summary (as of 2026-08-06)

| Area | Status |
|---|---|
| Auth (login, JWT, session-scoped logout) | ✅ Done |
| Branch CRUD (soft delete only) | ✅ Done |
| User CRUD (SUPER_ADMIN-only creation) | ✅ Done |
| Vendor Master | ✅ Done |
| Customer Master | ✅ Done |
| Product Master — Model Number | ✅ Redesigned: one serialized product = one `modelNumber` (was an array) — see §13 |
| Purchase — create (both CENTRAL and BRANCH paths) | ✅ Done, role-gated (SUPER_ADMIN/BRANCH_ADMIN only) |
| Purchase — CENTRAL batch created at purchase time, splittable across branches | ✅ Done — see §9 |
| Purchase — Bulk Receive activates BatchStock against that same batch | ✅ Reworked — see §9 |
| Purchase — system invoice PDF, S3-hosted, matches physical-invoice reference design | ✅ Done |
| Purchase — vendor-invoice-upload + payment-evidence-upload | ✅ Fixed, now S3 (were silently broken — see §6) |
| Purchase — Get By ID (detail fetch) | ✅ Enhanced — see §8 |
| Purchase — Get All (list + filters + statistics) | ✅ Enhanced — see §10 |
| Purchase — serialized items can now carry real purchase-time GST | ✅ Redesigned — see §17 (was hardcoded 0 for every serialized unit) |
| Purchase Create frontend (full component refactor) | ✅ Done — see `shopping-frontend/docs/FRONTEND_CHANGES.md` |
| Purchase Detail frontend (read-only, barcode printing) | ✅ Done — new screen, see §11 |
| Purchase Management (list) frontend (filters, stats dashboard, thermal print, invoice share) | ✅ Rebuilt — see §11 |
| Purchase Entry — Model Number auto-fill, Notes templates, payment status UNPAID label | ✅ Done — see §13 |
| StockMovement ledger (historical stock audit trail) | ✅ Wired into Purchase create, bulk-receive, AND Sale now |
| Bulk Receive (central purchase → branch stock) | ✅ Migrated to StockMovement/BatchStock — see §9 |
| Transfer (branch-to-branch) | ⏳ Not migrated yet |
| Sale — create + scanner lookup | ✅ Enhanced — see §12 |
| Sale — margin-scheme GST at sale time | ✅ Fixed — reads `GstConfig.marginSchemeRate` fresh per sale, no longer permanently 0 — see §17 |
| Sale — Get By ID (detail fetch) | ✅ Enhanced — see §15 |
| Sale — Get All (list + filters + statistics) | ✅ Enhanced — see §17 |
| Sale Create frontend (scanner-first entry screen) | ✅ Done — new screen, see §14 |
| Sale Detail frontend (read-only) | ✅ Done — new screen, see §16 |
| GstConfig (live GST rate settings) | ✅ Wired up — auto-creates on first read, CRUD at `/api/gst-config`, `createSale` reads it live — see §17 |
| AWS access key | 🚨 Quarantined by AWS as compromised — see §7, needs rotation outside this app |

---

## 1. Auth & Roles

Three roles: `SUPER_ADMIN`, `BRANCH_ADMIN`, `STAFF`. Only `SUPER_ADMIN` creates the other two — there is no public self-registration screen. Every authenticated request carries a JWT with a session id (`sid`), so logout ends exactly one session, not "most recent." `role`/`branchId`/`userId` are never trusted from the request body anywhere in the app — always derived from the authenticated user server-side.

## 2. Branch / Vendor / Customer (masters)

- **Branch**: soft-delete only (`isActive` toggle). Every place a `branchId` is accepted elsewhere in the app must resolve it as existing **and** active via the shared `resolveActiveBranch()` helper (`services/branchValidation.service.js`) — not just a valid ObjectId.
- **Vendor**: global (not branch-scoped), soft-delete only. Purchase now validates + snapshots it (see §3).
- **Customer**: branch-scoped (unlike Vendor). GST optional. Soft-delete only.

## 3. Purchase Flow (current, as of this session)

Entry point: `POST /purchase/create` (`createPurchase.controller.js`). Runs inside a single MongoDB transaction — either the whole purchase (items, batches, serials, inventory, pending receives) commits together, or none of it does. The system invoice PDF is generated **after** the transaction commits, deliberately outside it — a PDF/S3 failure must never roll back a real financial transaction.

### 3.1 Two purchase paths, decided by the caller's role

- **SUPER_ADMIN → `poType: CENTRAL`**: every item must specify its destination `branchId` explicitly. Nothing becomes available stock yet — a `PendingReceive` document is created per destination branch instead. Stock only becomes available later, at the (not-yet-migrated) bulk-receive step. **No `StockMovement` is written at this stage** — correctly so, since nothing has physically moved into a branch's stock yet.
- **BRANCH_ADMIN → `poType: BRANCH`, "direct receive"**: the purchasing branch is always the caller's own `user.branchId` (never trusted from the body). Stock becomes available immediately — batches/serials are created as `ACTIVE`/`AVAILABLE` in the same transaction, and a `StockMovement` row is written for each one.

### 3.2 Non-serialized items → Batch + BatchStock

Each non-serialized line (direct-receive only) gets its own `Batch` (global template, cost basis) and `BatchStock` (per-branch stock ledger). Batch numbers are **global per product**, not per branch — sequence comes from a `BatchCounter` keyed by `productCode` alone, producing e.g. `AAP20WCHR-B001`, `B002`, ... regardless of which branch received them. The barcode is the batch number itself.

GST fields (`gstApplicable`, `purchaseGstPercent`) are stamped onto both `Batch` and `BatchStock` from the purchase line. `saleGstPercent` is **deliberately left at its schema default (0)**, not copied from `purchaseGstPercent` — see §4, this is intentional.

### 3.3 Serialized items → ProductSerial

Each serial number gets its own `ProductSerial` document. On direct receive, `status: "AVAILABLE"` and `currentBranchId` set immediately; on a CENTRAL purchase, `status: "ASSIGNED"` (pending) with `assignedBranchId` set instead — no branch has it yet. Second-hand serialized products carry no purchase-time GST (`purchaseGstPercent` always 0) — `gstApplicable` is a manual per-unit toggle set at purchase time (never derived), driving margin-scheme GST later at sale time.

### 3.4 StockMovement — the historical ledger

Every time stock actually becomes available at a branch (batch or serial, direct-receive only), one `StockMovement` row is written in the same transaction (`services/purchase/recordStockMovement.js`). This is the audit trail answering "how did this branch's stock get to this number, and when" — `BatchStock.availableQuantity` / `ProductSerial.status` answer "what do I have right now." The ledger is append-only at the schema level (Mongoose blocks update/delete); corrections are always a new offsetting row, never an edit.

### 3.5 Vendor snapshot, payment handler, round-off

- `vendorId` is validated as existing **and** active (previously any string was accepted — fixed this session). `vendorSnapshot` (name/GST/phone/email/address) is frozen onto the purchase at creation time, so later Vendor edits never rewrite what an old purchase says.
- Every `paymentDetails[]` entry gets `handledBy` stamped from the authenticated user (`req.user`) — never trusted from the request body.
- `roundOffAmount` is computed server-side when `roundOff: true` is sent — never trusted as a client-supplied number.

### 3.6 System invoice → S3

After the transaction commits, a PDF invoice is generated in-memory (`jsPDF`, no local disk write) and uploaded to S3 under a unique key (`purchases/invoices/{purchaseNumber}-{timestamp}-{random}.pdf`) via the same `putObject` helper used by branch-logo/profile-image/product-image uploads. The resulting S3 URL is saved to `Purchase.systemInvoiceFile`. This is a one-time, permanent historical document — the generator service refuses to run again once `systemInvoiceFile` is already set, so a purchase's invoice can never be silently regenerated or overwritten.

The PDF's visual design (`pdfGenerator.service.js`) was redesigned to match a physical invoice the business supplied as a reference — header/company block, vendor details, a bordered items table, total/payment sections, signature block. The items table columns are fixed regardless of serialized/non-serialized: Product Name, Model, Serial Number, Description, Qty, HSN/SAC, GST%, GST Amount, Total Amount (`-` where a field doesn't apply to that row). `modelNumber` (from `ProductSerial`) and `description` (from `Product`) are attached in-memory onto the purchase object right before PDF generation — display-only enrichment, not persisted onto `Purchase.items[]` itself. The company address block uses the purchase's own branch (`Purchase.branchId → Branch.address/phones/email`) when there is one (BRANCH_ADMIN purchases); falls back to a generic default for CENTRAL purchases, which have no single branch.

### 3.7 Item-level `branchId` and HSN sourcing — fixed this session

Two real controller bugs, found via live testing against the actual payload shape now sent by the frontend:

- **`Purchase.items[].branchId` was hardcoded to `null` for every non-SUPER_ADMIN item** (`isSuperAdmin ? destinationBranchId : null`), even though `Purchase.branchId` (top-level) was already correct. Fixed to always be `destinationBranchId`, which already resolves correctly for both roles.
- **HSN is now sourced from `Product.hsnCode` for non-serialized items too** (previously only serialized items had this fix — non-serialized still trusted client-supplied `item.hsnCode`). The frontend never sends or asks for HSN at all now, for either product type; the controller rejects the purchase with a 400 if the selected product has no HSN set on its own master record, for both types identically.

### 3.8 Role restriction — fixed this session

`POST /purchase/create` had no role-restricting middleware — a `STAFF` token fell through both the `isSuperAdmin`/`isBranchAdmin` branches silently (both `false`), producing a `201` "success" response with `branchId: null` everywhere and zero real stock created. Fixed by adding the existing `onlyAdminRoles` middleware (already used on Product mutation routes) to the route — `STAFF` now gets a clean `403` before the controller ever runs. `POST /sale/create` was checked and confirmed intentionally unrestricted — `STAFF` needs sale access for their actual job, that's correct and untouched.

### 3.9 Vendor-invoice and payment-evidence uploads — fixed this session

`POST /purchase/upload-invoice` and `POST /purchase/upload-payment` both used route-level `multer` writing to local disk. Both were **silently non-functional**, not just off-convention: this app mounts `express-fileupload` globally (`app.use(fileUpload())` in `server.js`), which consumes the multipart body before a second `multer` parser on the same request ever gets a chance — always failing with "Unexpected end of form" (same class of bug already documented and fixed for User/Branch image uploads earlier in this project). Both migrated to the same `express-fileupload` + S3 `putObject` pattern used everywhere else — `uploadPurchaseInvoice.controller.js` (PDF, own inline validation) and `uploadPaymentEvidence.controller.js` (image, reuses `validateImageFile`/`MIME_TO_EXTENSION` from `uploadUserImage.middleware.js`). Both live-tested against real S3 (upload succeeds, wrong file type correctly rejected 400). The now-unused `uploadPaymentEvidence.middleware.js` (multer instance) was deleted; `uploadPurchaseInvoice.middleware.js` was repurposed to hold just the PDF validation function.

`POST /purchase/upload-signature` was **not** touched — still the same legacy multer/local-disk pattern, still presumably broken for the same reason. Not used anywhere in the current Purchase Create frontend, so out of scope for now — flagged here so it isn't mistaken for already-fixed.

## 4. GST rate-change design note (important, read before touching Sale)

Input GST (`purchaseGstPercent`, what was actually paid) is frozen per-transaction on `Purchase.items[]` forever — correct as-is. Output GST (what gets charged to a customer) is a function of the rate **in effect on the sale date**, not the purchase date — these can legitimately differ if the government changes the rate while stock sits in inventory. For this reason, `Batch.saleGstPercent` / `BatchStock.saleGstPercent` are intentionally left at 0 rather than copied from purchase-time GST. **The future Sale implementation must look the rate up fresh from `GstConfig` at the actual moment of sale**, never trust a value stamped here at purchase time — and must freeze whatever it looked up onto the `Sale` document itself, the same way Purchase already does, so a sale made today at 20% stays provably 20% forever even if the rate changes again tomorrow.

## 5. Known pre-existing data-integrity issue (found during Purchase testing, not caused by it)

`User` `_id 6a6843978a747e1949229b51` ("Ares", `BRANCH_ADMIN`) has a `branchId` that doesn't resolve to any existing `Branch` document — any branch-scoped action by this user (including creating a purchase) currently fails with a 400. Flagged as a separate task, not fixed as part of Purchase work.

## 6. Frontend

The Purchase Create screen (`shopping-frontend`) was fully refactored this session — one 2,332-line file into a dedicated `PurchaseCreate/` folder with real sub-components, matching this controller's contract exactly (one item per physical serialized unit, no client-supplied HSN, item-level `branchId` only for SUPER_ADMIN, payment status/paymentDetails built to satisfy the PAID/PARTIAL/PENDING validation rules in §3.5 by construction). Full detail, component list, and known limitations: `shopping-frontend/docs/FRONTEND_CHANGES.md`. Backend-side changes made specifically to support that refactor are §3.6–3.9 above.

## 7. Known incident — AWS access key quarantined as compromised

Found incidentally while cleaning up a test upload (`deleteObject` call). The response was:

```
AccessDenied ... with an explicit deny in an identity-based policy:
arn:aws:iam::aws:policy/AWSCompromisedKeyQuarantineV3
```

That policy name is AWS's own automated response to a leaked/compromised access key — AWS detected the `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in `.env` somewhere it shouldn't be and auto-quarantined the IAM user (`aap`), blocking a set of sensitive actions (confirmed: `s3:DeleteObject` is blocked; `s3:PutObject` still works, which is how this went unnoticed until now). **Not fixed by this session — requires action outside this codebase**: rotate the key in the AWS Console (deactivate old, generate new, update `.env` everywhere it's deployed), check Cost Explorer/Billing for unexpected usage, and check git history for the key ever having been committed. One harmless leftover: a 14-byte test PDF at `purchases/vendor-invoices/1785936093278-c2884ff0ec23.pdf` in the S3 bucket, undeletable until the key is rotated — trivial, no rush.

## 8. Get Purchase By ID — enhanced

`getPurchaseById.controller.js` existed already; enhanced in place (same route, same response envelope), not replaced. Real bugs fixed:

- **Invalid IDs now return `400`** (`mongoose.Types.ObjectId.isValid` check) — previously only checked for a missing param, so a malformed id fell through to a Mongoose `CastError` → `500`.
- **Serial-to-item cross-contamination fixed.** The old code grouped every `ProductSerial` by `productId` and attached the *whole* group to every item of that product — so two different physical units of the same product on one purchase both showed each other's serial/model/price data. Now matched by the item's own exact `serialNumber` (globally unique), so each line shows only its own unit.
- **`modelNumber` was missing from the response entirely** (it lives on `ProductSerial`, never on `Purchase.items[]`) — now enriched in per-item `serialDetails`, same in-memory-only pattern already used for the system invoice PDF.
- **Branch assignment made reliable for CENTRAL/pending items.** Added a bulk `Branch` lookup keyed by each item's own `branchId` (always set today, per §3.7) — this is the authoritative branch label now, not a fallback inferred from BatchStock/ProductSerial state that stays empty until something is actually received.
- `paymentDetails[].handledBy.userId` is now populated (name/email) so the frontend can show who handled a payment without a second request.

Live-tested against 4 real scenarios (BRANCH_ADMIN purchase, SUPER_ADMIN CENTRAL purchase, mixed serialized+non-serialized, purchase with payment details) plus the 400/404 error paths.

## 9. CENTRAL batch created at purchase time, splittable across branches

**The gap this closes:** a SUPER_ADMIN/CENTRAL purchase of a non-serialized product never got a `Batch` (no batch number, no barcode) until the old bulk-receive flow — and that flow didn't actually create one either, it only bumped the legacy `Inventory` collection. So CENTRAL non-serialized stock had no batch/barcode identity anywhere, ever. Business requirement: the batch (and its barcode) needs to exist and be printable **immediately at purchase time**, before the physical goods ship to any branch — matching how a real warehouse prints labels once, at the point stock enters the system, then ships already-labeled goods out.

**Design, and why:** a single purchased lot can legitimately be split across several destination branches as separate item lines (e.g. 60 units to Branch A, 40 to Branch B, one purchase). `createPurchase.controller.js` now groups CENTRAL non-serialized items by **product + cost-basis** (not by item/branch line) and creates exactly **one `Batch`** per group, right after the purchase itself saves — same moment as a direct-receive purchase. Two lines for the same product at a genuinely different price/GST correctly become two separate batches (two real lots), not one. `BatchStock` (the actual sellable-quantity ledger) is deliberately **not** created at this point — nothing has physically arrived anywhere yet; it's created later, per branch, when that branch confirms receipt.

`PendingReceive.items[]` gained `batchId`/`batchNumber` so receive-time knows which pre-existing batch to activate, instead of (as before) having no batch to reference at all.

`bulkReceiveController` reworked: for each non-serialized line received, it now finds-or-creates a `BatchStock` for `{batchId, branchId}` (using the Batch's own cost/GST as source of truth) and records a `PURCHASE_RECEIVE_CENTRAL` `StockMovement`. The legacy `Inventory` write is kept as a dual-write for backward compatibility, not removed — now genuinely redundant with `BatchStock`, flagged as a future cleanup rather than silently left looking necessary.

**Two more real bugs this surfaced, unrelated to the feature itself:**
- `BatchStock.barcode` had a *globally* unique index — correct only when one batch could ever have one `BatchStock` row (the old single-branch-only world). The instant the same batch legitimately ships to two branches, the second `BatchStock` insert collided on that index. Changed to unique per `{barcode, branchId}` and the stale index dropped from the live database.
- `bulkReceiveController` tried to `$set: { items: ... }` on `Purchase` via a query-level update to track per-item received quantity — but `items` is a frozen field (`PURCHASE_FROZEN_FIELDS`) on any non-`DRAFT` purchase, and every purchase defaults to `COMPLETED`. **This meant bulk-receive has been completely broken for every CENTRAL purchase since the freeze guard was added** earlier this session, unrelated to today's work — this was the first genuine end-to-end exercise of that endpoint since then. The write was also redundant (`PendingReceive`/`ProductSerial` already track receive progress correctly, and that's what `getPurchaseById` actually reads) — removed rather than patched around.

Live-tested end to end: one CENTRAL purchase of 100 units split 60/40 across two branches → one `Batch` with two destinations → received 55 good + 5 damaged at branch 1, 40 good at branch 2 → confirmed two independent `BatchStock` rows sharing the same `batchId`, correct `StockMovement` entries, correct aggregate `totalAvailableQuantity`.

## 10. Get All Purchases — enhanced into a real statistics API

`getAllPurchases.controller.js` existed already (list + a handful of counts); enhanced in place, same route/response envelope, existing fields preserved (`stats.overview`/`.purchaseStatus`/`.paymentStatus`/`.financial`, `pagination.total`/`.page`) with new fields added alongside rather than replacing them.

**The core bug fixed:** branch filtering only ever matched `purchase.branchId` — which is `null` on every CENTRAL purchase (the destination lives per item, see §9). Filtering by a branch silently missed every CENTRAL purchase assigned to it, including for the `BRANCH_ADMIN` auto-scope (`filter.branchId = user.branchId`), which had the identical bug for their own account. Fixed with `{ $or: [{ branchId }, { "items.branchId": branchId }] }` on a plain `find()` — never an aggregation `$unwind` — so a CENTRAL purchase split across branches still returns as exactly one row from either branch's filter, with no dedup logic needed (a `find()` never fans a document out per matching array element).

`BRANCH_ADMIN`/`STAFF` now have their branch scope **enforced**, not just defaulted: any client-supplied `branchId` query param is ignored outright for them, never merged with their own. Live-verified: a branch admin sending another branch's id got back their own unchanged data, not the other branch's.

Added: `poType` filter, search extended to vendor GST number/reference/product name+code/serial number/batch number (all via bounded pre-queries or direct nested-path regex, no N+1), date filtering switched from `createdAt` to `purchaseDate` (the actual business date).

**Statistics** (`stats`, `paymentStats`, `gstStats`, `productStats`, `amountStats`, `receiveStats`, `branchStats`, `vendorStats`, `purchaseTrend`) are computed over the **entire filtered set**, not the current page — one `Purchase.find(filter).lean()` fetch is the single source for all of them (every purchase's `items[]`/`paymentDetails[]` is already embedded, so this is plain JS reduction, not a `$facet` pipeline), plus two small bounded lookups scoped only to the CENTRAL purchases actually in that set (`PendingReceive`, `ProductSerial`, for receive-status) and one `Branch` lookup for `branchStats` (SUPER_ADMIN only). **Trade-off, disclosed rather than hidden:** this loads the whole filtered set into memory once — simpler and far less error-prone than a multi-branch aggregation pipeline at this app's realistic scale, but would need revisiting (a real `$facet`) if the purchase table grows very large.

**`branchStats[].paidAmount`/`.pendingAmount` are a proportional estimate**, disclosed as a genuine schema limitation: payment is recorded per-purchase, never per-branch-item, so a split CENTRAL purchase's paid/pending amount is allocated to each branch by its exact share of that purchase's item total. `purchaseAmount`/`itemLineCount`/`quantity` per branch are exact (summed directly from stored per-item `totalPrice`/`quantity`), only the paid/pending split is an approximation.

Added compound indexes to `Purchase` (`isDeleted`+`purchaseDate`/`branchId`/`poType`/`paymentStatus`/`status`/`vendorId`, plus `items.branchId`) — the schema had none beyond the unique `purchaseNumber` before this.

Live-tested: SUPER_ADMIN all/per-branch, the multi-branch CENTRAL purchase from both branch angles (one row each time, correct split attribution), a real branch admin vs. a blocked spoofing attempt, payment/date/search filters, pagination not skewing stats, and the `gstApplicable:true, purchaseGstPercent:0` case surfacing correctly in `gstRateBreakdown` instead of being dropped.

## 11. Frontend — Purchase Detail (new) and Purchase Management (rebuilt)

Two more frontend screens this session, both consuming the backend work in §8/§10 with **no further backend changes**. Full detail: `shopping-frontend/docs/FRONTEND_CHANGES.md`.

- **Purchase Detail** (`/purchases/:id`) — a route every other screen already linked to (View Details, WhatsApp/email share links, even the invoice-link builder) but that never actually existed. Fully read-only; barcode generation/printing (serial number for serialized, batch number for non-serialized) lives only here, never on Purchase Create.
- **Purchase Management** (`/purchases`, the list) — rebuilt from one 74KB file into a component folder: real backend-driven filters (search debounced, branch/payment/PO-type/status/vendor/date-range — every one a real query param, never filtered client-side), a 5-section statistics dashboard reading `stats`/`paymentStats`/`productStats`/`gstStats`/`receiveStats` verbatim, invoice download/WhatsApp/email actions (the S3 invoice URL is already public, no signed URLs or backend proxy needed), and a separate thermal-receipt print flow (58mm/80mm, isolated print window, deliberately never the full invoice design).
- Payment status `PENDING` is displayed as **"Unpaid"** everywhere in both screens (tooltip explains why: distinguishes it from "pending *amount*", which also applies to `PARTIAL` purchases) — the stored/filtered/queried value is still `PENDING` throughout the API and database, this is a frontend label only, via `src/utils/paymentStatus.js`.

## 12. Sale — create + scanner lookup, enhanced

`createSale.controller.js` and `getScannerBarcodeByAvailableProductController.js` existed already and were already mostly correct — branch was already derived from `req.user.branchId` (never trusted from the body), the whole create flow was already properly transactional, and non-serialized items already required the caller to name the exact batch (no FIFO, matches the project rule). Enhanced in place, same routes/exports/response envelope. **No Sale frontend exists yet** — this is backend-only.

### 12.1 The recurring bug: wrong-unit price/GST lookup

Both controllers re-derived `purchasePrice`/`gstApplicable`/`gstPercent`/`hsnCode` for a serialized unit by populating its parent `Purchase` and doing `purchase.items.find(item => item.productId === productId)`. The moment a purchase contains **two different serialized units of the same product** (routine - e.g. two phones bought together), `.find()` silently returns the *first* one's price/GST for every unit of that product, regardless of which specific serial is actually being sold or scanned. Fixed in both places by reading `ProductSerial.purchasePrice`/`.sellingPrice`/`.gstApplicable`/`.saleGstPercent` directly - these fields already exist specifically to avoid this lookup (added earlier this session). For non-serialized, the equivalent `BatchStock.purchasePrice`/`.purchaseGstPercent` are used directly instead of re-deriving via `Purchase.items.find(productId + batchId)` (that match happened to be unambiguous since `batchId` is unique, but was needless extra complexity given `BatchStock` already carries its own authoritative copy).

### 12.2 Never-client-trusted tax fields

Both controllers previously trusted `item.gstApplicable`/`item.gstPercent`/`item.hsnCode` from the request body. Fixed to match the rule already established for Purchase: HSN always from `Product.hsnCode` (create rejects with 400 if the product has none set); `gstApplicable` for a serialized unit is the toggle fixed at purchase time (`ProductSerial.gstApplicable`), never overridable at sale time; GST percent is never client-supplied for either product type.

### 12.3 GST percent - honest about what's not built yet

`saleGstPercent` (serialized, margin-scheme output GST) and the sale-time rate generally are supposed to come fresh from `GstConfig` at the moment of sale (see §4) - not wired yet, separate task. The scanner now returns `ProductSerial.saleGstPercent` (currently always `0`) rather than `purchaseGstPercent` (also `0`, but the *wrong field* - input tax, not output tax) - not inventing a rate, just not returning an actively-misleading one. Non-serialized uses `BatchStock.purchaseGstPercent` as a pragmatic stand-in (normal additive GST rates rarely change, unlike the always-zero margin-scheme case).

### 12.4 Non-serialized sale items - one batch per line

`Sale.modal.js`'s own schema comments already state the intended design: a non-serialized sale line is exactly one batch (flat `batchId`/`batchNumber`/`barcode` fields on the item), a second batch is a second line, and the legacy `batches[]` array is "never populated by new sales." The controller was out of sync with its own schema - it accepted an array of multiple batches per line, looped over them, and wrote the deprecated array with **client-echoed** `purchasePrice` (never validated against the real `BatchStock` cost). Fixed to match the schema's stated design: exactly one batch per line (`items[].batches` must have length 1, others rejected with a message to split into separate items), populating the flat fields from the validated `BatchStock` document, never from client input.

### 12.5 Other fixes

- A `quantity: 0` (or missing) was silently becoming `1` instead of being rejected - non-serialized now requires an explicit positive quantity. Serialized items are always treated as quantity 1 regardless of what's sent (they never need a client-supplied quantity at all - one serial is one unit).
- Deleted/deactivated products (`isActive`/`isDeleted`) are now actually checked in the scanner - previously populated but never read, so a deactivated product's stock could still scan as sellable.
- `StockMovement` is now written for every sale (serialized and non-serialized) - `type: "SALE"` already existed in the ledger's enum, waiting for exactly this; it was the one documented gap left in the StockMovement rollout.
- **Payment status enum changed from `PENDING` to `UNPAID`** for Sale specifically (unlike Purchase, where `PENDING` stays the stored value and only the frontend label reads "Unpaid" - Purchase already has a live screen depending on that value). Since Sale has no frontend yet, this was safe to do as a real schema/enum change rather than a display-only label. `Sale.modal.js`'s enum/default, `createSale.controller.js`'s derivation, and the three literal `"PENDING"` string comparisons in `getSaleById.controller.js`/`getAllSales.controller.js`/`statsSale.controller.js` were all updated together - leaving those three stale would have silently broken their counts for every sale created after this change.

Live-tested against real branch/stock data: available serial and batch scans (confirmed `modelNumber` now populates - was always `undefined` before), a wrong barcode (404), a different branch's admin blocked from seeing this branch's stock via the scanner, a non-serialized UNPAID sale (`BatchStock` deducted, `StockMovement` row correct), over-quantity rejected, a serialized PARTIAL sale (`ProductSerial` flipped to `SOLD`, `StockMovement` correct), re-selling that same now-SOLD serial rejected, a wrong-branch serialized sale attempt rejected, a `branchId` spoofed in the request body confirmed fully ignored (sale still correctly attributed to the real authenticated branch via direct DB check), PAID confirmed, and the multi-batch-per-line rejection confirmed.

## 13. Product Model Number redesign + Purchase Entry improvements

Three independent Purchase Entry changes, done together per one request.

**Model Number: array → single value.** `Product.modelNumbers` (array, required non-empty for serialized products) became `Product.modelNumber` (single string). A migration script backfilled `modelNumber = modelNumbers[0]` for every existing serialized product before the old field was dropped from the schema — any product that had more than one model number in the array keeps only the first, matching "one serialized product = one model number" going forward. `createProduct`/`updateProduct` controllers, the product-search endpoint (`getProductOptionsController` — this is the one Purchase Entry's product search actually calls), and the admin product list's search filter were all updated to the singular field. The `ModelNumberModal.jsx` picker popup on Purchase Create (pick-one-from-the-array) was deleted entirely — selecting a product now auto-fills its one model number immediately and moves focus straight to Serial Number, no popup step. **Incidental fix, no extra work required:** `getAvailableProducts.controller.js` (Sale-side) had a dead search clause already written against a field literally named `modelNumber` — it was a silent no-op before this rename (the real field was the old `modelNumbers`, plural) and now works correctly for free.

**Notes suggestion templates → user-managed, localStorage.** Purchase Create's hardcoded warranty-text suggestion chips were replaced with a `+ New Template` button opening a small modal (label + full text), saved to `localStorage` under `purchase_notes_templates`. No backend involvement at all. A hover-visible remove control on each chip. (Sale Create got the identical UX later, see §14 — with its own separate `sale_notes_templates` key, by design: a supplier-facing Purchase note template isn't necessarily relevant to a customer-facing Sale note.)

**Payment status "UNPAID" label — closed the remaining gaps.** `paymentStatusLabel()` (`src/utils/paymentStatus.js`) already correctly mapped the stored `PENDING` value to the display string `"UNPAID"` from earlier work — the gaps were call sites that bypassed it entirely: the Purchase Create screen's own payment badge and summary row (`PaymentDetails.jsx`/`PurchaseSummary.jsx` were rendering the raw `paymentStatus` prop, literally showing `"PENDING"` on screen), the Purchase Management filter dropdown option label, the payment stat card + its tooltip, the generated invoice PDF, and the WhatsApp/email share text — all now route through the shared label function. The stored/filtered/queried backend value is still `PENDING` everywhere, unchanged — this is display-only, matching the same convention already established for the rest of the Purchase UI.

## 14. Sale Create — frontend (new screen + bug-fix pass)

`src/pages/sale/SaleCreate/` — the Sale Create screen didn't exist as a proper component tree before this (only the old monolithic `SaleCreateEntryTable.jsx`, since deleted). Scanner-first: there is no product search anywhere on this screen, every item starts from typing or scanning a Serial Number or Batch Number. Built as entirely separate files from Purchase Create (used only as a visual/structural reference) per explicit requirement. Full component list, design decisions, and the `useScannerInput` reuse rationale: `shopping-frontend/docs/FRONTEND_CHANGES.md`.

**A real, confirmed bug found and fixed in a later pass**, worth calling out here since it's backend-adjacent: manual typing into the Serial Number/Batch Number field could send the **wrong value** to the scanner lookup API. Root cause: `useScannerInput`'s keystroke buffer (used to detect "Enter was pressed, dispatch a lookup") has no backspace handling — correcting a typo mid-entry left the buffer holding stale, garbled content different from what was actually visible in the field, and the old code trusted that buffer's value for the API call instead of the field's real content. Fixed by having both `SaleSerializedTable`/`SaleNonSerializedTable`'s scan handlers read the row's own React state (kept correct via the input's `onChange` for both scanning and typing — a scanner is just very fast native keystrokes into a focused input, indistinguishable from typing) instead of the hook's buffer value. Proved live: deliberately poisoned the buffer with a wrong barcode string while the field showed the correct one, and the actual API request still went to the correct value.

Other fixes in the same pass: the serialized GST cell now shows a real (disabled) percentage dropdown when `gstApplicable: true` and a plain `-` when `false` — previously always a static badge regardless; a `QuantityStepper` edge case where `batchAvailableQuantity: 0` could still let the stepper settle on quantity `1` (a `max || 1` fallback treating `0` as falsy) was hardened to correctly cap at `0`; Notes templates got the same localStorage feature as Purchase Create (§13), with its own separate `sale_notes_templates` key.

## 15. Get Sale By ID — enhanced

`getSaleById.controller.js` existed already; enhanced in place (same route, same response envelope). Populates everything a detail page needs in one query plus 7 batched `.populate()` calls (never one query per item — Mongoose batches each populate path with a single `$in` regardless of item count): customer (expanded to include `alternatePhone`/`city`/`state`/`country`/`pincode`/`customerCode`, not just the original 5 fields), branch, `createdBy`, **`updatedBy`** (was missing entirely), `items.productId`, `items.productSerialId`, and `paymentDetails.handledBy.userId`.

**Two real response-shaping bugs fixed, not business logic:**
- `barcode` was being unconditionally overwritten with `item.productSerialId?.barcode` — but `ProductSerial` has no `barcode` field at all, so this expression was always `""` and was silently wiping out the item's own real batch barcode for every non-serialized item. Fixed to use the item's own `barcode` field.
- `itemTotal` was computed as `item.totalPrice || sellingPrice * quantity` — but `item.totalPrice` doesn't exist on the schema (always `undefined`), so it always fell back to a calculation that ignores discount and GST entirely. Fixed to use `item.finalAmount`, the real precomputed total. Confirmed live on a real sale with GST applied: the old logic would have under-reported that item's total by the GST amount.

**Duplicates removed** (nothing built consumed them yet, so nothing broke): a `paymentSummary` object that just re-nested `paidAmount`/`pendingAmount`/`paymentStatus`/`paymentDetails`, all already at the top level; `summary.totalAmount`, duplicating the top-level field. `summary.roundOff: 0` is included since it was requested, but disclosed as an honest constant — Sale has no round-off concept in its business logic at all, unlike Purchase.

**Disclosed, not silently worked around:** `paymentDetails[].handledBy` populate was correctly wired here, but `createSale.controller.js` didn't actually stamp a `handledBy` value at creation time yet — so it resolved to empty until the write-side fix landed later (§17).

## 16. Sale Detail — frontend (new screen)

`src/pages/sale/SaleDetail/` — `/sale/:id`, read-only, consuming §15's enhanced API with no further backend changes needed at the time it was built. Purchase Detail was used only as a visual/structural reference (card shell, table style, tab-switcher, chip styling) — every component is a separate, Sale-only file. One deliberate departure from Purchase Detail's convention: the placeholder character for missing/empty values is a plain `-` throughout, not Purchase Detail's `—` em dash — an explicit requirement for this screen specifically.

```
SaleDetail/
├── SaleDetail.jsx                    — orchestrator, fetches Get Sale By ID
└── components/
    ├── SaleHeader.jsx                — back link, sale number, status pill, Edit Sale (toast-only stub)
    ├── SaleInfoCard.jsx              — sale#/date/branch/status/createdBy/updatedBy
    ├── CustomerCard.jsx              — prefers customerSnapshot over live customerId, falls back cleanly if the customer was since deleted
    ├── PaymentCard.jsx               — Preview (shared ImageViewer lightbox) + Download for payment evidence, not just a plain link like Purchase Detail has
    ├── SerializedProductsTable.jsx
    ├── NonSerializedProductsTable.jsx
    ├── SummaryCard.jsx               — Sub Total/Discount/GST/Grand Total/Paid/Pending, no Round Off row (Sale has none)
    └── NotesCard.jsx
```

`getSaleByIdAPI` returns the unwrapped sale object directly (not a `{success, data}` envelope like `getPurchaseByIdAPI`) — the loader reflects that difference deliberately, not copied verbatim from Purchase Detail's pattern. Live-tested against a real, deliberately awkward sale (pre-dating this session's Sale rework, with a deleted product reference and legacy-format `batches[]` data) — exercised the fallback paths (customer snapshot, "Unknown Product", empty model/batch numbers) directly rather than just the happy path. Route added alongside `/sale/create` and `/sale/:id/edit`, same full-bleed (no sidebar) treatment.

## 17. GST Architecture Redesign + Get All Sales — enhanced

A full audit (three parallel research passes across every GST-related field in the backend) found the GST implementation inconsistent in specific, confirmed ways — not patched individually, redesigned properly at the source.

**What was already correct, confirmed rather than assumed:** `Product` master never had a GST field (only `hsnCode`) — no change needed there. Non-serialized `gstApplicable` was already hardcoded `true` everywhere it's set — already matches "non-serialized products are always GST products."

**ProductSerial becomes the real source of truth for a serialized unit's purchase-time GST.** Added `purchaseGstAmount` and `hsnCode` (neither existed on the schema before — HSN lived only on the live `Product` document, meaning a later HSN edit could silently change what an old unit's invoice would show). `purchaseGstPercent` — previously hardcoded to `0` for every serialized purchase by an explicit "second-hand goods carry no input GST" rule — is now a real, client-settable value (confirmed with the user before changing): most second-hand purchases will still be `0` in practice since the Purchase Create frontend doesn't send this field yet, but the backend is no longer artificially blocked from capturing a real value when a unit is bought from a GST-registered dealer. `createPurchase.controller.js`'s serialized branch now computes and stores all three, and stamps `hsnCode` as a permanent snapshot (same pattern as `vendorSnapshot`/`customerSnapshot`) rather than leaving it to drift with the live Product master.

**Margin-scheme Sale GST — the actual root cause of "GST% = 0 / GST Amount = 0" on every serialized sale.** `createSale.controller.js` was reading `ProductSerial.saleGstPercent` — a field a full-repo grep confirmed was **never written to anything but its schema default of `0`, anywhere in the entire codebase**. Fixed by reading `GstConfig.marginSchemeRate` fresh, once per sale request (not per item — avoids N+1), and computing GST on the margin (`(sellingPrice - purchasePrice - discount) * rate / 100`) exactly as the margin-scheme logic already correctly did — it just had nothing real to multiply by. Confirmed live: a unit purchased with a 12% *input* GST, sold with the config's 6% margin-scheme rate, correctly shows a 6% *output* GST on the ₹5,000 profit (₹300) — proving Purchase GST and Sale GST are now genuinely independent, sourced from different places, as they should be. Non-serialized items are explicitly unaffected — normal additive GST correctly continues charging the same rate it was bought at (`BatchStock.purchaseGstPercent`), which was never the "different concepts" problem this fix addresses; that problem is specific to margin scheme.

**GstConfig, wired up for the first time.** The model existed since earlier this session but was **fully dead** — correctly defined, zero controllers or routes ever referenced it, no seed. Expanded from 2 rate fields to a real settings surface (company GST number/details, available GST rate list, margin scheme rate, standard rate, invoice settings), with a new minimal CRUD: `GET /api/gst-config` (auto-creates the one singleton document with schema defaults on first read — not a destructive migration) and `PUT /api/gst-config/update` (SUPER_ADMIN only). Confirmed live: 403 for a STAFF token, 200 + persisted update for SUPER_ADMIN.

**Bonus fix found while testing, same class of bug as the GST issue:** `createSale.controller.js` never stamped `productName`/`productCode` onto `Sale.items[]` either — the fields exist on the schema but were always empty. This silently broke the new Get All Sales "search by Product Name/Code" feature (built the same day) until caught by testing against real data, not assumed to work. `modelNumber` capture was added at the same time.

**`getAllSalesController` rebuilt to the same quality as `getAllPurchasesController`** — same route, same method, same response envelope, existing fields preserved with new ones added alongside. Replaced the previous 3-query pattern (find + `countDocuments` + a second find for stats with fully duplicated filter-construction code) with the same 2-query `Promise.all` pattern Purchase uses. Added `escapeRegex` (previously entirely absent — user search input went straight into `RegExp` unescaped). **A real security gap closed**: branch scoping previously delegated to a shared `getBranchFilter` middleware that gives any role other than `SUPER_ADMIN`/`BRANCH_ADMIN` (i.e. `STAFF`) an unscoped `{}` filter — every branch's sales, visible to anyone with a STAFF token. Scoping is now built inline in this controller (matching Purchase's verified-correct pattern), confirmed live: a `BRANCH_ADMIN` token now sees only their own branch's one sale, not the full dataset. Search now covers Sale Number (doubles as "Invoice Number" — Sale has no separate field, `saleNumber` is already invoice-formatted, e.g. `INV-1001`), product name/code/batch number/serial number (all directly embedded on `Sale.items[]` — no cross-collection query needed, an advantage Purchase's search doesn't have), and customer name/mobile/email (both the embedded `customerSnapshot` and a bounded live-`Customer` fallback query). Eight statistics objects computed via one pass of plain-JS reduction over the already-fetched filtered set (zero extra aggregation pipelines): `overview`, `financial`, `paymentStats`, `gstStats`, `productStats`, `customerStats`, `branchStats` (SUPER_ADMIN only), `saleTrend`. `Sale.modal.js` indexes replaced with `isDeleted`-leading compounds matching Purchase's proven convention (and a pre-existing redundant `saleNumber` index — duplicating the field-level `unique: true` — was removed while there).

**Disclosed, not fixed (out of scope for this task):** `Sale.customerSnapshot` is never actually populated by `createSale.controller.js` — confirmed via live data, always empty even on a sale with a real linked customer. Doesn't block anything (customer population covers display), but means `customerStats.topCustomers` currently shows "Unknown Customer." Flagged for a future task.

Live-verified end to end against the real dev database for every one of the above: GstConfig create/update/403, ProductSerial GST snapshot on a real purchase, margin-scheme math on a real sale, the Sale Detail `handledBy` fix (both write and read side), Get All Sales filters (branch scoping, payment status, date range), search (serial number, product name, product code, batch number — all confirmed matching only after the productName/productCode stamping fix), and all 8 statistics objects cross-checked against the known test data.
