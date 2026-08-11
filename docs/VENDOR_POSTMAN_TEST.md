# Vendor Master — Postman Test Guide (Development)

Scope: only the Vendor Master endpoints. No Product/Purchase/Sale/Inventory/Batch/Serial/Transfer/Branch/User endpoints are covered here.

Base URL used below: `http://localhost:3000/api` (adjust to your environment).

All responses follow this shape:
```json
{ "success": true|false, "statusCode": 200, "message": "...", "data": ... }
```

## Vendor is GLOBAL — read this first

**A Vendor does not belong to a branch.** There is no `branchId` field on the Vendor schema, no branch filter in any Vendor query, and no way for a client to attach one — any `branchId` sent in a create/update request body is simply never read. The same vendor is shared across every branch; a branch's Purchase records will later reference this same global vendor `_id` directly, never a per-branch copy.

## Dummy Data Used

```
SUPER_ADMIN    email: superadmin@test.com    password: Test@12345   (manages vendors)
BRANCH_ADMIN   email: branchadmin@test.com   password: Test@12345   (read-only consumer)
STAFF          email: staff@test.com         password: Test@12345   (read-only consumer)

Vendor:
  name: ABC Medical Supplies       companyName: ABC Medical Supplies Pvt Ltd
  email: vendor.test@example.com   phone: 9876543210    alternatePhone: 9876500000
  address: 123 Main Road           city: Chennai         state: Tamil Nadu
  country: India                   pincode: 600001
  vendorCode: VEND001              gstNumber: 33ABCDE1234F1Z5    panNumber: ABCDE1234F
```

**Note on field names:** `name` is the vendor's own required/unique display name; `companyName` is a separate, optional legal/registered name field — they are not the same thing and both are kept. `contactPerson` (pre-existing field) is the point-of-contact's name at the vendor, distinct from both. `address` stayed a flat string (existing field, unchanged) with new separate top-level `city`/`state`/`country`/`pincode` fields alongside it, rather than being restructured into a nested object, to avoid a breaking change to any existing vendor documents.

**Note on validation:** only `name` is required (matches the pre-existing rule). Email, phone, alternatePhone, GST, and PAN are all optional, but are format-validated *when provided*.

---

## 1. Authentication

### 1.1 Login (SUPER_ADMIN)
- **Method:** POST, **Endpoint:** `/auth/login`, **Auth required:** No
- **Dummy data:** `{ "email": "superadmin@test.com", "password": "Test@12345" }`
- **Expected status:** 200 — save `data.token` as `{{superAdminToken}}`.

### 1.2 Login (BRANCH_ADMIN / STAFF)
- Same endpoint, respective credentials — used only for negative authorization tests below.

---

## 2. Vendor Create

### 2.1 Create vendor (valid) ✅
- **Method:** POST, **Endpoint:** `/vendor/create`
- **Auth required:** Yes, **Required role:** SUPER_ADMIN only
- **Body:** see Dummy Data above
- **Expected status:** 201
- **Expected result:** returned vendor has no `branchId` property at all.

### 2.2 Invalid: missing name
- **Body:** `{ "phone": "9876543210" }`
- **Expected status:** 400 — "Vendor name is required"

### 2.3 Invalid: bad email / phone / GST / PAN format
- Each only fails when the field is actually provided with a bad value, e.g. `{ "name": "x", "email": "not-an-email" }`
- **Expected status:** 400 for each, with a field-specific message.

### 2.4 Invalid: duplicate name / GST / email / vendorCode
- Run 2.1 first, then repeat any of `name`, `gstNumber`, `email`, or `vendorCode` with the same value.
- **Expected status:** 409 in each case.
- Note: uniqueness only applies among non-deleted vendors (partial unique indexes scoped to `isDeleted:false`) — a deactivated vendor's name/GST/code can be reused by a new vendor.

### 2.5 Attempt to provide `branchId`
- **Body:** `{ "name": "x", "branchId": "64f000000000000000000000" }`
- **Expected status:** 201 — vendor is still created normally, and `branchId` never appears anywhere in the response, because the field doesn't exist on the schema at all.

### 2.6 Unauthorized / Forbidden
- No token → 401.
- BRANCH_ADMIN or STAFF token → 403 — "Only Super Admin can access this". Vendor management is SUPER_ADMIN only (stricter than Product, which also allows BRANCH_ADMIN).

---

## 3. Vendor Read

### 3.1 Get by ID
- **Method:** GET, **Endpoint:** `/vendor/:id` — **Expected status:** 200.
- A `GET /vendor/single/:vendorId` alias also still works, kept for backward compatibility with the pre-existing frontend.

### 3.2 Get by invalid ID format
- **Endpoint:** `/vendor/not-a-valid-id` — **Expected status:** 400.

### 3.3 Get by well-formed but nonexistent ID
- **Endpoint:** `/vendor/000000000000000000000000` — **Expected status:** 404.

### 3.4 List (paginated)
- **Endpoint:** `/vendor/list?page=1&limit=10` — **Expected status:** 200, `data.pagination` present.
- Default (no `isActive`/`includeInactive` param) shows active, non-deleted vendors only.

### 3.5 Search
- **Endpoint:** `/vendor/list?search=ABC` — matches name, contact person, phone, email, or GST number.

### 3.6 Filters
- `?isActive=true` — active only. `?isActive=false` — inactive only (includes both deactivated-via-delete and deactivated-via-update vendors). `?includeInactive=true` — everything, active and inactive alike.

### 3.7 Vendor options / stats
- `GET /vendor/options?search=...` — lightweight dropdown/typeahead shape, active vendors only.
- `GET /vendor/stats` — `{ totalVendors, activeVendors, inactiveVendors }`.

### 3.8 BRANCH_ADMIN / STAFF can read
- Same list/get endpoints with their tokens — **Expected status:** 200. Reads are open to every authenticated role; only mutations are SUPER_ADMIN-gated.

---

## 4. Vendor Update

### 4.1 Update fields
- **Method:** PUT, **Endpoint:** `/vendor/update/:id`, **Role:** SUPER_ADMIN only
- **Body:** any subset of the create fields, e.g. `{ "city": "Coimbatore", "notes": "Preferred supplier" }`
- **Expected status:** 200. Duplicate/format validation re-runs identically to create for any field actually being changed.
- `branchId`, `createdBy`, `createdAt`, and `isDeleted` are never read from the request body under any circumstance — only `isActive` (boolean) plus the listed business fields are ever assigned.

### 4.2 Invalid: malformed ID
- **Endpoint:** `/vendor/update/not-a-valid-id` — **Expected status:** 400.

### 4.3 Forbidden: STAFF/BRANCH_ADMIN cannot update
- **Expected status:** 403.

---

## 5. Vendor Deactivate / Reactivate

### 5.1 Deactivate (soft-delete)
- **Method:** DELETE, **Endpoint:** `/vendor/delete/:id`, **Role:** SUPER_ADMIN only
- **Expected status:** 200 — `isDeleted: true`, `isActive: false`, `deletedAt` set. The vendor document is never removed from the database, and any existing Purchase record referencing this vendor `_id` is completely unaffected.

### 5.2 Deactivated vendor still viewable by ID
- **Endpoint:** `GET /vendor/:id` — **Expected status:** 200 (not 404) — needed so it can still be found and reactivated.

### 5.3 Deactivated vendor excluded from the default list
- **Endpoint:** `GET /vendor/list?search=<deactivated vendor name>` — **Expected result:** empty `vendors` array (unless `isActive=false` or `includeInactive=true` is also passed).

### 5.4 Reactivate
- **Method:** PATCH, **Endpoint:** `/vendor/:id/reactivate`, **Role:** SUPER_ADMIN only
- **Expected status:** 200 — `isDeleted: false`, `isActive: true`, `deletedAt: null`.

### 5.5 Reactivate an already-active vendor
- **Expected status:** 400 — "Vendor is already active"

### 5.6 Forbidden: STAFF/BRANCH_ADMIN cannot deactivate/reactivate
- **Expected status:** 403.

---

## Final Checklist

- [x] Vendor is confirmed global — no `branchId` field, no branch filter anywhere, client-supplied `branchId` is a no-op
- [x] Full CRUD + reactivate implemented and tested
- [x] Name/GST/email/vendorCode duplicate prevention, scoped to active (non-deleted) vendors only
- [x] Email/phone/GST/PAN format validation, only enforced when the field is provided
- [x] Soft delete / reactivate round-trip verified, including on a vendor with a pre-existing empty GST/PAN (no validation blocks a pure status-toggle save)
- [x] SUPER_ADMIN manages; BRANCH_ADMIN and STAFF are read-only; unauthenticated is rejected
- [x] Invalid ID handling returns 400, not 500
- [x] Existing Purchase-record compatibility preserved (Vendor deactivation never touches or cascades to any other collection)
