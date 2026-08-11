# Purchase — Create — Postman Test Guide (Development)

Scope: only `POST /purchase/create` (this session's work). Does not cover `GET /purchase`, `GET /purchase/:id`, `GET /purchase/stats`, `POST /purchase/check-serial`, or the legacy `/purchase/upload-invoice` / `/upload-signature` / `/upload-payment` routes (untouched this session, still multer/local-disk based — see `docs/APP_FLOW.md` §3.7).

Base URL used below: `http://localhost:3000/api` (adjust to your environment).

All responses follow this shape:
```json
{ "success": true|false, "statusCode": 200, "message": "...", "data": ... }
```

## Two purchase paths, decided entirely by the caller's role — read this first

- **SUPER_ADMIN** → `poType: "CENTRAL"`. Every item must include its own `branchId` in the request. Nothing becomes available stock yet — no `Batch`/`BatchStock`/`StockMovement` is created. Instead one `PendingReceive` per destination branch is created, to be resolved later by the (separate, not-yet-migrated) bulk-receive flow.
- **BRANCH_ADMIN** → `poType: "BRANCH"`, "direct receive". The destination branch is always the caller's own `user.branchId` — any `branchId` sent in the body for BRANCH_ADMIN items is ignored. Stock becomes available immediately: `Batch`+`BatchStock` (non-serialized) or `ProductSerial` (serialized) are created `ACTIVE`/`AVAILABLE`, and a `StockMovement` row is written for each.
- A bare authenticated token with neither role (e.g. STAFF) is **not blocked at the route level** — there is no role-restricting middleware on `/purchase/create` — but produces broken/undefined behavior inside the controller. Not a supported use of this endpoint.

## GST — item-level, manual, and different per product type

- **Non-serialized**: normal additive GST. `hsnCode` and `purchaseGstPercent` are required per item; `gstApplicable` is always effectively `true`.
- **Serialized**: margin-scheme GST for second-hand goods. `gstApplicable` is a manual per-unit toggle you set on the item (`true`/`false`) — never derived. `purchaseGstPercent` always stays `0` for serialized (no input GST at purchase time). The rate actually charged at sale time is a separate, later decision (see `docs/APP_FLOW.md` §4) — nothing here decides it.

## Vendor must be real and active

`vendorId` is validated as existing **and** active (`isDeleted:false`, `isActive:true`) — same principle as branch validation. A `vendorSnapshot` (name/GST/phone/email/address) is frozen onto the purchase at creation time.

## Dummy Data Used

```
SUPER_ADMIN    email: superadmin@test.com    password: Test@12345
BRANCH_ADMIN   email: branchadmin@test.com   password: Test@12345   (branch: {{branchId}})
```

The Setup section below pulls a real active vendor, an active + inactive branch, and one serialized + one non-serialized product directly from your dev database — no product/vendor dummy data is hardcoded, since these need real `_id`s from your environment.

---

## 0. Setup

### 0.1 Login (SUPER_ADMIN / BRANCH_ADMIN)
- **Method:** POST, **Endpoint:** `/auth/login`, **Auth required:** No
- Save `data.token` as `{{superAdminToken}}` / `{{branchAdminToken}}`.

### 0.2 Get branches
- **Method:** GET, **Endpoint:** `/branch/list` (SUPER_ADMIN token)
- Set `{{branchId}}` = the BRANCH_ADMIN test user's own active branch, `{{inactiveBranchId}}` = any deactivated branch's `_id`.

### 0.3 Get an active vendor and a deactivated vendor
- **Method:** GET, **Endpoint:** `/vendor/list` (or equivalent) — set `{{vendorId}}` (active) and `{{inactiveVendorId}}` (deactivated).

### 0.4 Get one non-serialized product and one serialized product
- **Method:** GET, **Endpoint:** `/product/options?type=non-serialized` → set `{{nonSerializedProductId}}`.
- **Method:** GET, **Endpoint:** `/product/options?type=serialized` → set `{{serializedProductId}}`.

---

## 1. Create Purchase — BRANCH_ADMIN, direct receive (valid)

### 1.1 Combined non-serialized + serialized items, round-off on
- **Method:** POST, **Endpoint:** `/purchase/create`, **Auth:** BRANCH_ADMIN token
- **Body:**
```json


{
  "vendorId": "{{vendorId}}",
  "supplierInvoiceNumber": "SUP-INV-1001",
  "reference": "Postman test",
  "roundOff": true,
  "paymentStatus": "PAID",
  "paymentDetails": [],
  "items": [
    {
      "productId": "{{nonSerializedProductId}}",
      "quantity": 3,
      "purchasePrice": 100.3,
      "sellingPrice": 150,
      "hsnCode": "8504",
      "purchaseGstPercent": 18
    },
    {
      "productId": "{{serializedProductId}}",
      "serialNumbers": [
        { "serialNumber": "PMTEST-0001" },
        { "serialNumber": "PMTEST-0002" }
      ],
      "purchasePrice": 500,
      "sellingPrice": 700,
      "gstApplicable": true
    }
  ]
}
```
- **Expected:** 201.
  - `data.purchase.vendorSnapshot.name` matches the vendor used.
  - `data.purchase.totalAmount` is a whole number (round-off applied), `data.purchase.roundOffAmount` non-zero.
  - `data.purchase.paymentDetails` (if any were sent) each have `handledBy.userId` equal to the BRANCH_ADMIN's own id — never anything the client could have sent.
  - `data.batches[0].batchNumber` matches `<productCode>-B0XX` — **no branch code embedded**.
  - `data.systemInvoice.url` is an `https://...s3....amazonaws.com/...` URL (S3-hosted, not `/uploads/...`).
  - Follow-up `GET /purchase/{{purchaseId}}` to inspect `items[].gstApplicable` / `purchaseGstPercent` per line.

---

## 2. Create Purchase — SUPER_ADMIN, CENTRAL (valid)

### 2.1 Item with explicit branchId
- **Auth:** SUPER_ADMIN token. **Body:** same shape as 1.1, but each item includes `"branchId": "{{branchId}}"` and no `serialNumbers`/two items are fine to keep simple — one non-serialized item is enough.
- **Expected:** 201, `data.purchase.poType` = `"CENTRAL"`, `data.purchase.branchId` = `null`, message mentions "Items assigned to 1 branch(es)". No `data.batches` key in the response (nothing was directly received).

---

## 3. Validation Errors

### 3.1 Missing vendorId
- **Body:** `{ "items": [...] }` (no `vendorId`) → **Expected:** 400 "Vendor is required".

### 3.2 Invalid vendorId format
- **Body:** `{ "vendorId": "not-an-id", "items": [...] }` → **Expected:** 400 "Invalid vendor ID".

### 3.3 Non-existent vendorId
- **Body:** `{ "vendorId": "000000000000000000000000", "items": [...] }` → **Expected:** 404 "Vendor not found".

### 3.4 Deactivated vendor
- **Body:** `{ "vendorId": "{{inactiveVendorId}}", "items": [...] }` → **Expected:** 400 "This vendor is deactivated and cannot be used for a new purchase".

### 3.5 Missing items
- **Body:** `{ "vendorId": "{{vendorId}}", "items": [] }` → **Expected:** 400 "At least one item is required".

### 3.6 Non-existent product
- **Body:** item with `"productId": "000000000000000000000000"` → **Expected:** 404 "Product not found: ...".

### 3.7 Non-serialized: missing HSN
- **Body:** non-serialized item without `hsnCode` → **Expected:** 400 "`<product>` HSN/SAC is required".

### 3.8 Non-serialized: quantity 0
- **Body:** `"quantity": 0` → **Expected:** 400 "`<product>` quantity must be greater than 0".

### 3.9 Purchase price not greater than 0
- **Body:** `"purchasePrice": 0` → **Expected:** 400 "Purchase price must be greater than 0".

### 3.10 Selling price less than purchase price
- **Body:** `"sellingPrice"` lower than `"purchasePrice"` → **Expected:** 400 "Selling price cannot be less than purchase price".

### 3.11 Serialized: no serial numbers
- **Body:** serialized item with `"serialNumbers": []` → **Expected:** 400 "`<product>` requires at least one serial number".

### 3.12 Serialized: duplicate serial in the same request
- **Body:** `"serialNumbers": [{"serialNumber": "DUP1"}, {"serialNumber": "DUP1"}]` → **Expected:** 500/409-style error "Duplicate serial numbers found: DUP1" (surfaces via the catch block).

### 3.13 Serialized: serial already exists
- Run 1.1 first (creates `PMTEST-0001`), then repeat with the same serial number → **Expected:** 409 "Serial numbers already exist: PMTEST-0001".

### 3.14 SUPER_ADMIN: missing per-item branchId
- **Auth:** SUPER_ADMIN. **Body:** item without `branchId` → **Expected:** 400 "Item 1: Branch ID is required for SUPER_ADMIN purchase".

### 3.15 Invalid / deactivated branch
- **Body:** item `"branchId": "{{inactiveBranchId}}"` → **Expected:** 400 "Branch `<id>`: This branch is deactivated and cannot be assigned".

### 3.16 PARTIAL payment mismatch
- **Body:** `"paymentStatus": "PARTIAL"`, `"paidAmount": 100`, but `"paymentDetails"` summing to a different amount → **Expected:** 400 "Sum of payment details (...) does not match paidAmount (...)".

---

## 4. Auth

### 4.1 No token
- Any request, no `Authorization` header → **Expected:** 401 "Unauthorized: No token provided".

### 4.2 Invalid/expired token
- `Authorization: Bearer invalid.token.here` → **Expected:** 401.

---

## What Was Actually Tested Live (this session)

Both success paths were run directly against the dev database via a script that invoked `createPurchaseController` in-process (not through HTTP, to avoid needing a running server) with real fixture vendor/branch/product/user documents already in the dev DB:

- **BRANCH_ADMIN direct receive**, combined non-serialized + serialized items, round-off on: verified `vendorSnapshot`, whole-number `totalAmount` + non-zero `roundOffAmount`, batch number with no branch code embedded (`AAP20WCHR-B0XX`), `Batch`/`BatchStock` GST fields stamped and `saleGstPercent` left at 0, both `ProductSerial` records `AVAILABLE` with `gstApplicable` set and `purchaseGstPercent` at 0, all 3 expected `StockMovement` rows (1 batch + 2 serials) with correct `unitCost`/`gstPercent`, and a real S3-hosted `systemInvoiceFile` URL.
- **SUPER_ADMIN CENTRAL**, single non-serialized item: verified `handledBy` stamped from the authenticated user on a real payment detail entry, `poType: "CENTRAL"` / `branchId: null`, a `PendingReceive` created for the target branch, and **zero** `StockMovement` rows (correct — nothing has reached a branch yet).

Every document created during both test runs (`Purchase`, `Batch`, `BatchStock`, `ProductSerial`, `StockMovement`, `PendingReceive`, and the `Inventory` delta) was deleted/reverted afterward, scoped by exact `_id` only. `PurchaseCounter`/`BatchCounter` sequence numbers were incremented by these runs and were not reverted (monotonic by design — harmless).
