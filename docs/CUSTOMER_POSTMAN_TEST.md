# Customer Master — Postman Test Guide (Development)

Scope: only the Customer Master endpoints. No Product/Purchase/Sale/Inventory/Batch/Serial/Transfer/Branch/User endpoints are covered here.

Base URL used below: `http://localhost:3000/api` (adjust to your environment).

All responses follow this shape:
```json
{ "success": true|false, "statusCode": 200, "message": "...", "data": ... }
```

## Customer is BRANCH-SCOPED — read this first

Unlike Vendor (a global master), **every Customer belongs to exactly one active Branch**. `branchId` is required on the schema and validated as existing + active on every create/update via the shared `resolveActiveBranch()` helper.

- **SUPER_ADMIN**: may create/view/manage customers for **any** branch. Must supply `branchId` in the create body (there is no "default branch" for a SUPER_ADMIN, since they have none assigned).
- **BRANCH_ADMIN / STAFF**: always operate on **their own branch only**. `branchId` sent in a create body is ignored for these roles — it is always derived from the authenticated user's own `branchId`, never trusted from the request. Reassigning an *existing* customer to a different branch (via `PUT /customer/update/:id` with `branchId` in the body) is **SUPER_ADMIN-only** — BRANCH_ADMIN/STAFF get a 403.
- Every list/search/get/update/delete/reactivate query is branch-scoped for BRANCH_ADMIN/STAFF (a customer belonging to another branch returns 404, not 403 — it should look indistinguishable from "doesn't exist" to someone outside that branch).

## GST is OPTIONAL

GST is never required. When provided, it's validated for format (`GST_REGEX`) and checked for duplicates — but only **within the same branch** (the same GST-registered company could legitimately be a customer at two different branches).

## Dummy Data Used

```
SUPER_ADMIN    email: superadmin@test.com    password: Test@12345
BRANCH_ADMIN   email: branchadmin@test.com   password: Test@12345   (branch: {{branchId}})
STAFF          email: staff@test.com         password: Test@12345   (branch: {{branchId}})

Customer WITH GST:
  name: ABC Medical Pvt Ltd        mobile: 9876543210
  email: abcmedical@example.com    gstNumber: 27AAAPL1234C1ZV
  address: 123 Main St             city: Coimbatore   state: Tamil Nadu
  country: India                   pincode: 641001

Customer WITHOUT GST:
  name: Walk-in Customer           mobile: 9876500001
```

**Field note:** the phone field is named `mobile` on the schema/API (not `phone`) — kept as-is because Sale/Inventory/Dashboard already read `customer.mobile` via `populate()`; renaming would have silently broken those (out of scope for this phase). `alternatePhone`, `city`, `state`, `country`, `pincode`, and `customerCode` are new additive fields.

**Note on validation:** only `name` and (for SUPER_ADMIN) `branchId` are required. Email, mobile, alternatePhone, GST, and customerCode are all optional, but are format-validated / duplicate-checked (within the branch) *when provided*.

---

## 0. Setup

### 0.1 Login (SUPER_ADMIN / BRANCH_ADMIN / STAFF)
- **Method:** POST, **Endpoint:** `/auth/login`, **Auth required:** No
- Save each `data.token` as `{{superAdminToken}}` / `{{branchAdminToken}}` / `{{staffToken}}`.
- `BRANCH_ADMIN`/`STAFF` must both belong to the **same** branch (`{{branchId}}`) for the branch-isolation tests below to be meaningful.

### 0.2 Get an active branchId, a second active branchId, and an inactive branchId
- **Method:** GET, **Endpoint:** `/branch/list` (SUPER_ADMIN token)
- Set `{{branchId}}` = an active branch (matching your BRANCH_ADMIN/STAFF test users), `{{branchId2}}` = a *different* active branch (for reassignment/cross-branch tests), `{{inactiveBranchId}}` = any deactivated branch's `_id` (deactivate one via `PUT /branch/update/:id` with `{"isActive": false}` if none exists).

---

## 1. Create Customer

### 1.1 Create WITH GST (valid)
- **Method:** POST, **Endpoint:** `/customer/create`, **Auth:** BRANCH_ADMIN or STAFF token
- **Body:** the "Customer WITH GST" dummy data above.
- **Expected:** 201, `data.branchId` populated with the caller's own branch, `data.gstNumber` echoed uppercased.

### 1.2 Create WITHOUT GST (valid)
- **Body:** the "Customer WITHOUT GST" dummy data above (no `gstNumber` key at all).
- **Expected:** 201 — GST is never required.

### 1.3 Create as SUPER_ADMIN, explicit branchId (valid)
- **Auth:** SUPER_ADMIN token. **Body:** `{ "name": "...", "branchId": "{{branchId2}}" }`.
- **Expected:** 201, customer created under `branchId2` even though SUPER_ADMIN has no branch of their own.

### 1.4 Invalid: Missing name
- **Body:** `{ "mobile": "9876543210" }` → **Expected:** 400 "Customer name is required".

### 1.5 Invalid: Missing branchId (SUPER_ADMIN only)
- **Auth:** SUPER_ADMIN. **Body:** `{ "name": "No Branch" }` (no `branchId`) → **Expected:** 400 "Branch ID is required".

### 1.6 Invalid: Non-existent branchId
- **Body:** `{ "name": "x", "branchId": "000000000000000000000000" }` → **Expected:** 404 "Branch not found".

### 1.7 Invalid: Deactivated branchId
- **Body:** `{ "name": "x", "branchId": "{{inactiveBranchId}}" }` → **Expected:** 400 "This branch is deactivated and cannot be assigned".

### 1.8 Invalid: bad email / phone / alternatePhone / GST format
- Each only fails when the field is actually provided with a bad value, e.g. `{ "name": "x", "email": "not-an-email" }` → 400.

### 1.9 Invalid: duplicate mobile / email / GST / customerCode (same branch)
- Run 1.1 first, then repeat with the same `mobile` (or `email`/`gstNumber`/`customerCode`) in the **same branch** → 409. Note: the exact same value in a *different* branch is allowed (branch-scoped uniqueness).

### 1.10 Attempted branch injection (BRANCH_ADMIN/STAFF)
- **Auth:** BRANCH_ADMIN. **Body:** `{ "name": "Injection Test", "branchId": "{{branchId2}}" }`
- **Expected:** 201, but `data.branchId` is the caller's **own** branch (`branchId`), not `branchId2` — proves `branchId` from the body is never trusted for non-SUPER_ADMIN roles.

---

## 2. Get Customer

### 2.1 Get by ID (valid)
- **Method:** GET, **Endpoint:** `/customer/:id` — **Expected:** 200, full customer detail with populated `branchId`/`createdBy`.

### 2.2 Invalid: bad ID format
- **Endpoint:** `/customer/not-a-valid-id` → **Expected:** 400 "Invalid customer ID".

### 2.3 Invalid: well-formed but non-existent ID
- **Endpoint:** `/customer/000000000000000000000000` → **Expected:** 404 "Customer not found".

---

## 3. List / Search / Filter

### 3.1 List (pagination)
- **Endpoint:** `/customer/list?page=1&limit=10` → **Expected:** 200, `data.customers[]` + `data.pagination`.

### 3.2 Search
- **Endpoint:** `/customer/options?search=ABC` — matches name, mobile, email, or GST number.

### 3.3 Branch filter (SUPER_ADMIN)
- **Endpoint:** `/customer/list?branchId={{branchId}}` (SUPER_ADMIN token) → only that branch's customers.
- BRANCH_ADMIN/STAFF sending a *different* branchId in this query has no effect — they're always forced to their own branch.

### 3.4 Active customers
- **Endpoint:** `/customer/list` (default, no `isActive` param) → active, non-deleted only.

### 3.5 Inactive customers
- **Endpoint:** `/customer/list?isActive=false` → deactivated customers only (run after 5.1 below).

---

## 4. Update

### 4.1 Update fields
- **Method:** PUT, **Endpoint:** `/customer/update/:id` — **Body:** any subset of name/mobile/alternatePhone/email/address/city/state/country/pincode/customerCode/gstNumber/notes/isActive.

### 4.2 Change branch (SUPER_ADMIN only)
- **Auth:** SUPER_ADMIN. **Body:** `{ "branchId": "{{branchId2}}" }` → **Expected:** 200, branch reassigned (validated existing+active first).

### 4.3 Forbidden: Change branch as BRANCH_ADMIN/STAFF
- Same request, BRANCH_ADMIN/STAFF token → **Expected:** 403 "Only Super Admin can reassign a customer's branch".

### 4.4 Invalid branch on update
- **Body:** `{ "branchId": "{{inactiveBranchId}}" }` (SUPER_ADMIN) → 400, same as create.

---

## 5. Soft Delete / Reactivate

### 5.1 Deactivate
- **Method:** DELETE, **Endpoint:** `/customer/delete/:id` → **Expected:** 200, `isActive:false`, `isDeleted:true`, `deletedAt` set. Document remains in the database (verify via `includeInactive=true` list query).

### 5.2 Reactivate
- **Method:** PATCH, **Endpoint:** `/customer/:id/reactivate` → **Expected:** 200, `isActive:true`, `isDeleted:false`, `deletedAt:null`.

### 5.3 Reactivate an already-active customer
- Repeat 5.2 on a customer that's already active → 400 "Customer is already active".

---

## 6. Branch Isolation & Authorization

### 6.1 Cross-branch GET denied
- Move/create a customer under `branchId2`, then GET it with a BRANCH_ADMIN/STAFF token scoped to `branchId` → **Expected:** 404 (not 403 — indistinguishable from non-existent).

### 6.2 Cross-branch UPDATE/DELETE denied
- Same customer, PUT/DELETE with the wrong-branch token → 404 "Customer not found or access denied".

### 6.3 SUPER_ADMIN unrestricted
- SUPER_ADMIN GET on the same customer → 200, works regardless of branch.

### 6.4 No token
- Any endpoint, no `Authorization` header → 401 "Unauthorized: No token provided".

### 6.5 Invalid/expired token
- `Authorization: Bearer invalid.token.here` → 401.

---

## What Was Actually Tested Live (this session)

Create (with/without GST, as BRANCH_ADMIN/STAFF/SUPER_ADMIN), get by ID, list/pagination, search, branch filter, update, branch reassignment (allowed for SUPER_ADMIN, blocked 403 for BRANCH_ADMIN), deactivate, reactivate, non-existent branch (404), deactivated branch (400), branch-injection-ignored-for-non-SUPER_ADMIN, cross-branch isolation on GET/UPDATE/LIST (404, confirmed for both BRANCH_ADMIN and STAFF), SUPER_ADMIN cross-branch access, no-token (401), invalid ID format (400), missing name (400), invalid GST format (400), invalid email (400), invalid alternatePhone (400), duplicate mobile/GST within branch (409), active/inactive filters.

Using three dedicated QA accounts created for this test session (`qacustsuper@example.com` / `qacustadmin@example.com` / `qacuststaff@example.com`, all `Test@12345`) against two real branches already in the dev database. Both the QA accounts and every customer document created during testing were deleted afterward (see final report). The `superadmin@test.com` / `branchadmin@test.com` / `staff@test.com` dummy emails documented above follow the same convention used by the Vendor Master docs — set up your own equivalents (or reuse ones already in your dev DB) to run this collection.
