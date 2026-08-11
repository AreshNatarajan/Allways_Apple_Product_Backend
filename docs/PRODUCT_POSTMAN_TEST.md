# Product Master — Postman Test Guide (Development)

Scope: only the Product Master endpoints. No Purchase/Sale/Inventory/Batch/Serial/Transfer/Vendor/Customer/GST/Dashboard endpoints are covered here.

Base URL used below: `http://localhost:3000/api` (adjust to your environment).

All responses follow this shape:
```json
{ "success": true|false, "statusCode": 200, "message": "...", "data": ... }
```

## Dummy Data Used

```
SUPER_ADMIN   email: superadmin@test.com   password: Test@12345
STAFF         email: staff@test.com        password: Test@12345   (for negative authorization tests)

Non-serialized product:
  name: Dev Wireless Mouse   category: ACCESSORY
  productCode: PMDEV001      hsnCode: 847160

Serialized product:
  name: Dev Business Laptop   category: LAPTOP
  modelNumbers: [DEV-MODEL-A1, DEV-MODEL-A2]   hsnCode: 851712
```

**Note on field names:** the schema uses `hsnCode` (not `hsn`) and `modelNumbers` (plural array, not `modelNumber`) — these are the project's existing field names from before this phase, kept as-is rather than renamed, per the design decision to reuse existing names and avoid breaking the several other collections (`BatchStock`, `Sale`, `Transfer`, `ReceiveHistory`) that already store their own denormalized copies of `productCode`/`hsnCode`.

**Note on category:** `category` is a plain string enum directly on Product (`ACCESSORY`, `MOBILE`, `LAPTOP`) — there is no separate Category collection.

**Note on branch scoping:** Product has no `branchId` field. Products are global, not branch-scoped — any authenticated SUPER_ADMIN or BRANCH_ADMIN can manage any product, and any authenticated user (including STAFF) can read the full product catalog.

---

## 1. Authentication

### 1.1 Login (SUPER_ADMIN or BRANCH_ADMIN)
- **Method:** POST
- **Endpoint:** `/auth/login`
- **Auth required:** No
- **Dummy data:** `{ "email": "superadmin@test.com", "password": "Test@12345" }`
- **Expected status:** 200
- **Expected result:** `data.token` present. Save as `{{superAdminToken}}`.

### 1.2 Login (STAFF)
- Same endpoint, STAFF credentials. Save as `{{staffToken}}` — used only for negative authorization tests below.

---

## 2. Product Create

### 2.1 Create non-serialized product ✅
- **Method:** POST
- **Endpoint:** `/product/create`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN or BRANCH_ADMIN
- **Body:**
  ```json
  { "name": "Dev Wireless Mouse", "category": "ACCESSORY", "isSerialized": false, "productCode": "PMDEV001", "hsnCode": "847160", "description": "Dev test" }
  ```
- **Expected status:** 201
- **Expected result:** Returned product has `productCode: "PMDEV001"`, `modelNumbers: []`, `images: []`, `imageKeys: []`, `createdByRole` matches the caller's role.

### 2.2 Create serialized product ✅
- **Method:** POST
- **Endpoint:** `/product/create`
- **Body:**
  ```json
  { "name": "Dev Business Laptop", "category": "LAPTOP", "isSerialized": true, "modelNumbers": ["DEV-MODEL-A1", "DEV-MODEL-A2"], "hsnCode": "851712" }
  ```
- **Expected status:** 201
- **Expected result:** Returned product has `modelNumbers` array populated, `hsnCode` set, and **no `productCode` key at all** (not `null` — the field is entirely absent from the document).

### 2.3 Invalid combination: serialized + productCode
- **Body:** `{ "name": "x", "category": "MOBILE", "isSerialized": true, "modelNumbers": ["A"], "productCode": "SHOULD-NOT-STICK" }`
- **Expected status:** 201 (not rejected — see note below)
- **Expected result:** Product is created successfully but the response has **no `productCode` field**. This is existing, intentional schema behavior: `productCode` has a Mongoose setter that returns `undefined` whenever `isSerialized` is `true`, so the invalid combination can never actually persist. It is silently normalized rather than rejected with a 400 — this was true before this phase and was preserved as-is.

### 2.4 Invalid: non-serialized missing productCode
- **Body:** `{ "name": "x", "category": "MOBILE", "isSerialized": false, "hsnCode": "1" }`
- **Expected status:** 400 — "Product Code is required for non-serialized products"

### 2.5 Invalid: serialized missing modelNumbers
- **Body:** `{ "name": "x", "category": "MOBILE", "isSerialized": true, "hsnCode": "1" }`
- **Expected status:** 400 — "At least one Model Number is required for serialized products"

### 2.6 Invalid: missing hsnCode (either type)
- **Body:** `{ "name": "x", "category": "MOBILE", "isSerialized": true, "modelNumbers": ["A"] }` (or the non-serialized equivalent with `productCode` but no `hsnCode`)
- **Expected status:** 400 — "HSN/SAC Code is required"
- HSN is common to both product types and is checked before the serialized/non-serialized branch, so this fails regardless of `isSerialized`.

### 2.7 Invalid: duplicate Product Code
- Run 2.1 first, then repeat with the same `productCode`.
- **Expected status:** 409 — "Product Code already exists"
- Note: the uniqueness constraint only applies among non-deleted products (partial unique index on `productCode` scoped to `isDeleted:false`) — a soft-deleted product's old code can be reused by a new product.

### 2.8 Unauthorized: no token
- **Expected status:** 401

### 2.9 Forbidden: STAFF cannot create
- Same request with `{{staffToken}}`.
- **Expected status:** 403 — "Only Super Admin or Branch Admin can access this"

---

## 3. Product Read

### 3.1 Get by ID
- **Method:** GET, **Endpoint:** `/product/:id`, **Auth:** Yes, **Role:** any authenticated
- **Expected status:** 200

### 3.2 Get by invalid ID format
- **Endpoint:** `/product/not-a-valid-id`
- **Expected status:** 400 — "Invalid product ID"

### 3.3 Get by well-formed but nonexistent ID
- **Endpoint:** `/product/000000000000000000000000`
- **Expected status:** 404

### 3.4 Get list (paginated)
- **Endpoint:** `/product?page=1&limit=10`
- **Expected status:** 200, `data.pagination` has `total`/`page`/`limit`/`totalPages`

### 3.5 Search
- **Endpoint:** `/product?search=Dev`
- Matches `name`, `productCode`, or any entry in `modelNumbers` (case-insensitive).

### 3.6 Filter by category
- **Endpoint:** `/product?category=LAPTOP`

### 3.7 Filter by isSerialized
- **Endpoint:** `/product?isSerialized=true` or `?isSerialized=false`

### 3.8 Filter by isActive
- **Endpoint:** `/product?isActive=false`
- Only surfaces products deactivated via a plain update (`isDeleted` still `false`); a fully soft-deleted product (`isDeleted:true`) never appears in list results regardless of this filter, since the base filter always excludes `isDeleted:true`.

### 3.9 Product search options (typeahead)
- **Endpoint:** `/product/options?search=Dev&type=serialized`
- `type` is `serialized` | `non-serialized` | omitted (all).

### 3.10 Product stats
- **Endpoint:** `/product/stats`
- Returns `{ totalProducts, activeProducts, inactiveProducts, categoriesCount }`.

### 3.11 STAFF can read
- Same list/get endpoints with `{{staffToken}}`.
- **Expected status:** 200 — reads are open to any authenticated role.

---

## 4. Product Update

### 4.1 Update common fields
- **Method:** PUT, **Endpoint:** `/product/:id`, **Role:** SUPER_ADMIN or BRANCH_ADMIN
- **Body:** `{ "name": "Dev Wireless Mouse v2", "hsnCode": "847199" }`
- **Expected status:** 200

### 4.2 Update modelNumbers on a serialized product
- **Body:** `{ "modelNumbers": ["DEV-MODEL-A1", "DEV-MODEL-A2", "DEV-MODEL-A3"] }`
- **Expected status:** 200

### 4.3 Change serialization type (safety guard)
- **Body:** `{ "isSerialized": true, "modelNumbers": ["X"] }` sent against a non-serialized product (its existing `hsnCode` carries over since HSN is common to both types and doesn't need to be resent).
- **Expected status:** 200 **only if** no `Batch`, `BatchStock`, `ProductSerial`, or `Inventory` record references this product yet.
- **If any such record exists:** 409 — "Cannot change serialization type: this product already has Batch, Inventory, or Serial records that depend on its current type. Deactivate this product and create a new one instead." This is a read-only existence check against those collections; nothing in Purchase/Sale/Inventory/Batch/Serial/Transfer is modified by Product Master.

### 4.4 Invalid: malformed ID
- **Endpoint:** `/product/not-a-valid-id`
- **Expected status:** 400

### 4.5 Forbidden: STAFF cannot update
- **Expected status:** 403

---

## 5. Product Deactivate / Reactivate

### 5.1 Deactivate (soft-delete)
- **Method:** DELETE, **Endpoint:** `/product/:id`, **Role:** SUPER_ADMIN or BRANCH_ADMIN
- **Expected status:** 200
- **Expected result:** `isDeleted: true`, `isActive: false`, `deletedAt` set. Product is never removed from the database.

### 5.2 Deleted product excluded from default list
- **Endpoint:** `/product?search=<deleted product name>`
- **Expected result:** empty `products` array.

### 5.3 Reactivate
- **Method:** PATCH, **Endpoint:** `/product/:id/reactivate`, **Role:** SUPER_ADMIN or BRANCH_ADMIN
- **Expected status:** 200
- **Expected result:** `isDeleted: false`, `isActive: true`, `deletedAt: null`.
- Note: this is a new endpoint added in this phase — previously there was no way to reach a soft-deleted product again, since every other Product endpoint filters `isDeleted:false`.

### 5.4 Reactivate an already-active product
- **Expected status:** 400 — "Product is already active"

### 5.5 Forbidden: STAFF cannot deactivate/reactivate
- **Expected status:** 403

---

## 6. Product Images

### 6.1 Upload one or more images
- **Method:** POST, **Endpoint:** `/product/:id/images`, **Role:** SUPER_ADMIN or BRANCH_ADMIN
- **Content-Type:** `multipart/form-data`, field name **`images`** (repeat the field for multiple files)
- **Expected status:** 201
- **Expected result:** `data.images` (URLs) and `data.imageKeys` (S3 keys) both grow by the number of files uploaded. Storage keys are always server-generated (`products/{productId}/{timestamp}-{random}.{ext}`) — the client's filename is never used.

### 6.2 Invalid file type
- Upload a `.txt`/`.pdf`.
- **Expected status:** 400 — "Only JPG, JPEG, PNG and WEBP images are allowed"

### 6.3 Oversized file
- Upload a file over 5MB.
- **Expected status:** 400 — "Image must be 5MB or smaller"

### 6.4 No file uploaded
- **Expected status:** 400 — "No image file(s) uploaded"

### 6.5 Remove one image by key
- **Method:** DELETE, **Endpoint:** `/product/:id/images`, **Body:** `{ "key": "<imageKey from 6.1>" }`
- **Expected status:** 200
- **Expected result:** the matching entry is removed from both `images` and `imageKeys` at the same index; the S3 object is deleted best-effort (see note below).
- **Known infrastructure caveat:** the project's AWS credentials are currently under `AWSCompromisedKeyQuarantineV3`, which explicitly denies `s3:DeleteObject`. The DB state still updates correctly and the request still returns 200, but the underlying S3 object is not actually removed until the credentials are rotated — this is a pre-existing account-level issue, not a bug in this endpoint.

### 6.6 Remove the same key again
- **Expected status:** 404 — "Image not found on this product"

### 6.7 Forbidden: STAFF cannot upload/remove images
- **Expected status:** 403

---

## Final Checklist

- [x] Common fields (name, images[], description, category, hsn/hsnCode, isSerialized) validated on create and update
- [x] Serialized products use `modelNumbers[]`, never `productCode`
- [x] Non-serialized products use `productCode`, never `modelNumbers`
- [x] `hsnCode` is required for both serialized and non-serialized products - validation is no longer conditional on `isSerialized` (field name kept as `hsnCode`, per the project's existing naming, not renamed to `hsn`)
- [x] Category enum preserved, not reinvented
- [x] Duplicate Product Code prevented among active products only
- [x] Soft delete / reactivate round-trip verified
- [x] Multi-image upload, invalid-type rejection, and removal verified
- [x] SUPER_ADMIN / BRANCH_ADMIN can manage; STAFF is read-only; unauthenticated is rejected
- [x] Invalid ID handling returns 400, not 500
