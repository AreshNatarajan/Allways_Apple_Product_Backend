# Phase 1 — User & Branch Postman Test Guide (Development)

Scope: only the User, Branch, and Auth endpoints touched in Phase 1/1.5. No Purchase/Sale/Inventory/Batch/Transfer/GST/Product/Vendor/Customer endpoints are covered here.

Base URL used below: `http://localhost:3000/api` (adjust to your environment).

All responses follow this shape:
```json
{ "success": true|false, "statusCode": 200, "message": "...", "data": ... }
```

## Dummy Data Used

```
SUPER_ADMIN   email: superadmin@test.com        password: Test@12345
BRANCH_ADMIN  name: Test Branch Admin  email: branchadmin@test.com   password: Test@12345
STAFF         name: Test Staff         email: staff@test.com         password: Test@12345
Branch        name: Test Chennai Branch   code: TESTCHN01
              email: testbranch@test.com  phones: ["9000000001"]
              address.city: Chennai  address.state: Tamil Nadu  address.pincode: 600001
Branch 2      name: Test Bangalore Branch code: TESTBLR02   (for role-change / reassignment tests)
```

**Note on field names:** the Branch schema does not have `branchName`/`branchCode`/`phone`/`city`/`state`/`pincode` as flat fields — the actual fields are `name`, `code`, `phones` (array), and a nested `address` object (`addressLine1`, `addressLine2`, `city`, `state`, `country`, `pincode`). The requests below use the real field names.

**Note on branch `code` format (updated):** `code` must match `^[A-Z0-9]{2,10}$` — uppercase letters and digits only, 2–10 characters, **no hyphens**. This is now enforced on both create and update (previously it was only enforced on update — creating a branch with a code like `TEST-CHN-001` will now be rejected with 400).

**Prerequisite — if no SUPER_ADMIN exists yet in your dev database:** `POST /auth/register` with `{ "name": "...", "email": "superadmin@test.com", "password": "Test@12345" }` creates exactly one bootstrap SUPER_ADMIN (any `role`/`branchId` you send is ignored/overridden). If a SUPER_ADMIN already exists, this endpoint always returns 403 — that's expected, skip it and just log in.

---

## 1. Authentication

### 1.1 Login
- **Method:** POST
- **Endpoint:** `/auth/login`
- **Auth required:** No
- **Required role:** None
- **Dummy data:** `{ "email": "superadmin@test.com", "password": "Test@12345" }`
- **Expected status:** 200
- **Expected result:** `data.token` present, `data.user` has no `password` field. Save `data.token` as `{{superAdminToken}}`.

### 1.2 Logout
- **Method:** POST
- **Endpoint:** `/auth/logout`
- **Auth required:** Yes (Bearer token)
- **Required role:** Any authenticated user
- **Dummy data:** none (body empty)
- **Expected status:** 200
- **Expected result:** `{ "success": true, "message": "Logout successful", "data": null }`. Closes only the session tied to the token used — other active sessions for the same user are unaffected.

---

## 2. SUPER_ADMIN User (own profile)

### 2.1 Get own profile ✅ Implemented
- **Method:** GET
- **Endpoint:** `/user/{{superAdminId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** none
- **Expected status:** 200
- **Expected result:** Full user object (no `password`), `branchId` populated with `{_id, name, code, isActive}` if set. This endpoint was added since the last revision of this doc — previously there was no single-user read endpoint at all.

### 2.2 Update own profile
- **Method:** PUT
- **Endpoint:** `/user/{{superAdminId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN (acting on their own `_id`)
- **Dummy data:** `{ "name": "Test Super Admin Updated", "phone": "9000000000" }`
- **Expected status:** 200
- **Expected result:** Updated user object returned, no `password` field.

### 2.3 Change own password
- **Method:** PUT
- **Endpoint:** `/user/{{superAdminId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `{ "password": "NewTest@12345" }`
- **Expected status:** 200
- **Expected result:** Success response, no password/hash in response. Log in again with the new password to confirm it changed.

### 2.4 Upload/update own profile image
- **Method:** POST
- **Endpoint:** `/user/{{superAdminId}}/profile-image`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `multipart/form-data`, field name `image`, a real `.jpg`/`.png`/`.webp` file under 5MB
- **Expected status:** 200
- **Expected result:** `data.profilePhoto` is a new S3 URL. Re-uploading replaces it (old S3 object is deleted best-effort; failure to delete the old object does not fail the request). Uploading a non-image file (e.g. `.txt`) → 400 `"Only JPG, JPEG, PNG and WEBP images are allowed"`.

---

## 3. User Management (SUPER_ADMIN only)

### 3.1 Create BRANCH_ADMIN
- **Method:** POST
- **Endpoint:** `/user/create-branch-admin`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:**
```json
{
  "name": "Test Branch Admin",
  "email": "branchadmin@test.com",
  "phone": "9000000002",
  "password": "Test@12345",
  "branchId": "{{branchId}}"
}
```
- **Expected status:** 201
- **Expected result:** New user with `role: "BRANCH_ADMIN"`. Save `data._id` as `{{branchAdminId}}`. (Any `role` sent in the body is ignored — this endpoint always creates a BRANCH_ADMIN.)
- **Branch validation (updated):** `branchId` is now fully validated, not just checked for ObjectId shape:
  - Missing → 400 `"Branch ID is required"`
  - Malformed ObjectId → 400 `"Invalid branch ID"`
  - Well-formed but no such branch exists → 404 `"Branch not found"`
  - Branch exists but `isActive: false` → 400 `"This branch is deactivated and cannot be assigned"`

### 3.2 Create STAFF
- **Method:** POST
- **Endpoint:** `/user/create-staff`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:**
```json
{
  "name": "Test Staff",
  "email": "staff@test.com",
  "phone": "9000000003",
  "password": "Test@12345",
  "branchId": "{{branchId}}"
}
```
- **Expected status:** 201
- **Expected result:** New user with `role: "STAFF"`. Save `data.staff._id` as `{{staffId}}`.
- **Branch validation (new — this endpoint previously had none beyond ObjectId shape):** same four cases as 3.1 (required / invalid format / not found / deactivated).

### 3.3 Get user by ID ✅ Implemented (new)
- **Method:** GET
- **Endpoint:** `/user/{{staffId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** none
- **Expected status:** 200
- **Expected result:** Full user object (no password), `branchId` populated.

### 3.4 Get / list users
- **Method:** GET
- **Endpoint:** `/user/list?page=1&limit=10&role=STAFF&search=test&isActive=true`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** query params only, all optional: `role`, `branchId`, `search`, and **`isActive`** (new — `true`/`false`; omit to get all non-deleted users regardless of active status)
- **Expected status:** 200
- **Expected result:** `data.users[]` (no password fields), `data.pagination`. With `isActive=false`, only deactivated users are returned; with `isActive=true`, only active ones.

### 3.5 Edit BRANCH_ADMIN
- **Method:** PUT
- **Endpoint:** `/user/update-branch-admin/{{branchAdminId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `{ "name": "Test Branch Admin Updated", "phone": "9000000012" }`
- **Expected status:** 200
- **Expected result:** Updated BRANCH_ADMIN object. (This endpoint does not accept `branchId` — use the generic `PUT /user/:id` in 3.8 to reassign a branch admin's branch.)

### 3.6 Edit STAFF
- **Method:** PUT
- **Endpoint:** `/user/update-staff/{{staffId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `{ "name": "Test Staff Updated", "phone": "9000000013" }`
- **Expected status:** 200
- **Expected result:** Updated STAFF object.
- **Branch reassignment validation (new — previously this endpoint accepted any well-formed `branchId` with zero existence/active check):** if `branchId` is included and differs from the current one, the same four validation cases from 3.1 now apply (required only when actually changing it / invalid format / not found / deactivated).

### 3.7 Activate/deactivate user
- **Implemented** via the generic update endpoint.
- **Method:** PUT
- **Endpoint:** `/user/{{staffId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `{ "isActive": false }`
- **Expected status:** 200
- **Expected result:** `data.isActive: false`. A deactivated user gets 403 `"User account is inactive"` on their next login attempt (confirmed live). Reactivate with `{ "isActive": true }` before continuing.
- Note: this endpoint blocks deactivating the **last remaining active SUPER_ADMIN** (409) — test only on the STAFF/BRANCH_ADMIN test accounts.
- **This is the only "delete" mechanism for a User.** There is no hard-delete or separate soft-delete endpoint — the `isDeleted` field exists on the schema but no controller ever sets it. Deactivate (`isActive: false`) is the complete, working "Delete User" flow: the record stays in the DB, the user can't log in, and they're excluded from `GET /user/list` whenever `isActive=true` is requested.

### 3.8 Change role
- **Implemented** via the generic update endpoint.
- **Method:** PUT
- **Endpoint:** `/user/{{staffId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `{ "role": "BRANCH_ADMIN", "branchId": "{{branchId2}}" }` (use a **second** test branch that doesn't already have a BRANCH_ADMIN — promoting to BRANCH_ADMIN is rejected with 409 if the target branch already has one)
- **Expected status:** 200
- **Expected result:** `data.role: "BRANCH_ADMIN"`, `data.branchId` updated.
- **Branch validation applies here too:** promoting into a deactivated or non-existent branch is rejected the same way as create.

### 3.9 Assign/reassign branch
- **Implemented** via the generic update endpoint.
- **Method:** PUT
- **Endpoint:** `/user/{{staffId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `{ "branchId": "{{branchId}}" }`
- **Expected status:** 200
- **Expected result:** `data.branchId` updated to the new branch.
- **Branch validation applies here too** — reassigning to a deactivated or non-existent branch is rejected (see section 9 below for a full worked test flow).

### 3.10 Reset BRANCH_ADMIN password
- **Method:** PUT
- **Endpoint:** `/user/update-branch-admin/{{branchAdminId}}` (or the generic `/user/{{branchAdminId}}`)
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `{ "password": "NewBranchAdmin@123" }`
- **Expected status:** 200
- **Expected result:** Success, no password in response. Confirm by logging in as the BRANCH_ADMIN with the new password.

### 3.11 Reset STAFF password
- **Method:** PUT
- **Endpoint:** `/user/update-staff/{{staffId}}` (or the generic `/user/{{staffId}}`)
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `{ "password": "NewStaff@123" }`
- **Expected status:** 200
- **Expected result:** Success, no password in response. Confirm by logging in as STAFF with the new password.

### 3.12 Update user profile image (another user)
- **Method:** POST
- **Endpoint:** `/user/{{staffId}}/profile-image`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `multipart/form-data`, field name `image`, image file
- **Expected status:** 200
- **Expected result:** `data.profilePhoto` updated for the target user (SUPER_ADMIN manages everyone's image, not just their own).

---

## 4. Branch Management (SUPER_ADMIN only)

### 4.1 Create Branch
- **Method:** POST
- **Endpoint:** `/branch/create-with-admin`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:**
```json
{
  "name": "Test Chennai Branch",
  "code": "TESTCHN01",
  "email": "testbranch@test.com",
  "phones": ["9000000001"],
  "address": {
    "city": "Chennai",
    "state": "Tamil Nadu",
    "country": "India",
    "pincode": "600001"
  },
  "isActive": true
}
```
- **Expected status:** 201
- **Expected result:** `data.branch.id` — new branch id (note the response is wrapped: `data.branch.{...}`, unlike Update Branch below which returns the branch fields flat at `data.{...}` — a pre-existing inconsistency between the two controllers, not something this round changed). (Despite the route name, this only creates the Branch — it does not create a branch admin. Create the admin separately via 3.1.)
- **Validation (new — previously only enforced on update, not create):**
  - `code` must match `^[A-Z0-9]{2,10}$` → 400 `"Code must be 2-10 characters (uppercase letters and numbers only)"` if not (e.g. a hyphenated code like `TEST-CHN-001` now fails here too)
  - `email`, if provided, must be a valid format → 400 if not
  - each entry in `phones`, if provided, must be 10 digits → 400 naming the bad entry if not
  - duplicate `code` → 409 `"Branch code already exists"`

### 4.2 Get Branch (by id)
- **Method:** GET
- **Endpoint:** `/branch/{{branchId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN (any branch) or BRANCH_ADMIN/STAFF (only their own assigned branch — a foreign branch id returns 403)
- **Dummy data:** none
- **Expected status:** 200
- **Expected result:** `data.branch` plus `data.users.admin` / `data.users.staff` for that branch. Works regardless of the branch's active status (so SUPER_ADMIN can inspect a deactivated branch by id).

### 4.3 Get all Branches
- **Method:** GET
- **Endpoint:** `/branch/list?search=test`
- **Auth required:** Yes
- **Required role:** Any authenticated role (not restricted to SUPER_ADMIN)
- **Dummy data:** query param `search` optional
- **Expected status:** 200
- **Expected result:** Array of branches (`_id`, `name`, `code`, `address`, `phones`) — **active branches only** by default.
- **New:** `?includeInactive=true` — **SUPER_ADMIN only** — also returns deactivated branches (needed to find one worth reactivating, since there was previously no way to discover a deactivated branch's id via listing at all). BRANCH_ADMIN/STAFF always get active-only regardless of this param.
- Related, SUPER_ADMIN-only variants: `GET /branch/pagination?page=1&limit=10` (same `includeInactive=true` support, and this one does include `isActive` in each returned branch) and `GET /branch/stats` (returns `{ totalBranches, activeBranches, inactiveBranches }`).

### 4.4 Update Branch
- **Method:** PUT
- **Endpoint:** `/branch/update/{{branchId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `{ "name": "Test Chennai Branch Updated", "phones": ["9000000099"] }`
- **Expected status:** 200
- **Expected result:** Updated branch object, returned flat at `data.{...}` (not wrapped in `data.branch`).
- Note: the `code` format rule (`^[A-Z0-9]{2,10}$`) already applied here before this round and still does.

### 4.5 Activate/deactivate Branch
- **Implemented** via the same update endpoint.
- **Method:** PUT
- **Endpoint:** `/branch/update/{{branchId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `{ "isActive": false }`
- **Expected status:** 200
- **Expected result:** `data.isActive: false`. Reactivate with `{ "isActive": true }` before continuing.
- **This is the only "delete" mechanism for a Branch**, same reasoning as User (3.7). A working soft-delete function (`deleteBranchController`, sets `isDeleted`/`deletedAt`) does exist in the codebase but is **not wired to any route** — deliberately left that way this round rather than adding a second, redundant "removal" concept alongside the tested-and-working deactivate flow.
- A deactivated branch is confirmed (live-tested) to:
  - Disappear from `GET /branch/list` and `GET /branch/pagination` by default (visible again only via `includeInactive=true`)
  - Reject new STAFF/BRANCH_ADMIN creation against it (`POST /user/create-staff`, `POST /user/create-branch-admin`)
  - Reject reassigning an existing user into it (`PUT /user/update-staff/:id`, `PUT /user/:id`)
  - Reject promoting a user into a BRANCH_ADMIN role targeting it
  - Still remain viewable directly via `GET /branch/:id` (so you can find it again to reactivate it if you already have its id)

### 4.6 Upload/update Branch logo
- **Method:** POST
- **Endpoint:** `/branch/{{branchId}}/logo`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** `multipart/form-data`, field name `image`, image file
- **Expected status:** 200
- **Expected result:** `data.logo` is a new S3 URL. Re-uploading replaces it (old object deleted best-effort). Non-image file → 400.

GST fields: not applicable, none exist on the Branch schema.

---

## 5. Login / Logout History

### 5.1 List login history (all users)
- **Method:** GET
- **Endpoint:** `/user/login-history?page=1&limit=20`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** none required
- **Expected status:** 200
- **Expected result:** `data.history[]`, each entry has `userId` (populated with name/email/role), `role`, `branchId`, `loginAt`, `logoutAt` (null until logout).

### 5.2 List login history for one user
- **Method:** GET
- **Endpoint:** `/user/login-history?userId={{staffId}}`
- **Auth required:** Yes
- **Required role:** SUPER_ADMIN
- **Dummy data:** none
- **Expected status:** 200
- **Expected result:** Only entries where `userId` matches `{{staffId}}`.

### 5.3 Confirm logout closes the right session
1. Log in as STAFF → save token as `{{staffToken}}`.
2. `POST /auth/logout` with `Authorization: Bearer {{staffToken}}` → 200.
3. `GET /user/login-history?userId={{staffId}}` as SUPER_ADMIN → the most recent entry for that login should now have `logoutAt` set (not null). Earlier/other sessions for the same user, if any, are unaffected.

---

## 6. Authorization Tests

All rows below use the same dummy bodies as the equivalent SUPER_ADMIN test above; only the token/role changes. Expected status for every "DENY" row is **403**.

| Area | SUPER_ADMIN | BRANCH_ADMIN | STAFF |
|---|---|---|---|
| Create user (`POST /user/create-staff`) | 201 ALLOW | 403 DENY | 403 DENY |
| Get user by id (`GET /user/:id`) | 200 ALLOW | 403 DENY | 403 DENY |
| Edit any user (`PUT /user/{{staffId}}`) | 200 ALLOW | 403 DENY | 403 DENY |
| Reset a password | 200 ALLOW | 403 DENY | 403 DENY |
| Change role / reassign branch | 200 ALLOW | 403 DENY | 403 DENY |
| Own profile edit (`PUT /user/{{ownId}}`) | 200 ALLOW | 403 DENY | 403 DENY |
| Own password change | 200 ALLOW | 403 DENY | 403 DENY |
| Own profile image upload | 200 ALLOW | 403 DENY | 403 DENY |
| Create Branch (`POST /branch/create-with-admin`) | 201 ALLOW | 403 DENY | 403 DENY |
| Update Branch | 200 ALLOW | 403 DENY | 403 DENY |
| Branch logo upload | 200 ALLOW | 403 DENY | 403 DENY |
| List all users (`GET /user/list`) | 200 ALLOW | 403 DENY | 403 DENY |
| Login history (`GET /user/login-history`) | 200 ALLOW | 403 DENY | 403 DENY |
| Branch pagination (`GET /branch/pagination`) | 200 ALLOW | 403 DENY | 403 DENY |

Additional isolation check:
- **STAFF/BRANCH_ADMIN requesting a different branch's id** (`GET /branch/{{otherBranchId}}`) → **403 DENY**. Requesting their **own** assigned branch id → 200 ALLOW.

---

## 7. JWT Tests

### 7.1 No token
- **Method:** GET
- **Endpoint:** `/user/list`
- **Auth required:** N/A (omit the `Authorization` header entirely)
- **Expected status:** 401
- **Expected result:** `"Unauthorized: No token provided"`

### 7.2 Invalid token
- **Method:** GET
- **Endpoint:** `/user/list`
- **Header:** `Authorization: Bearer not.a.valid.token`
- **Expected status:** 401
- **Expected result:** `"Unauthorized: Invalid or expired token"`

### 7.3 Expired token
- **Optional / advanced** — Postman alone cannot forge a validly-signed expired token without the server's `JWT_SECRET`. Skip this in routine Postman testing, or ask a developer with server access to generate one for a one-off check.
- **Expected status (if tested):** 401, same message as 7.2.

### 7.4 Valid SUPER_ADMIN token
- **Method:** GET
- **Endpoint:** `/user/list`
- **Header:** `Authorization: Bearer {{superAdminToken}}`
- **Expected status:** 200

---

## 8. User ↔ Branch Relationship Validation (new section)

This is the main thing that changed this round: a valid ObjectId is no longer treated as good enough anywhere a `branchId` is accepted. Every path below now goes through the same check (a shared `resolveActiveBranch` helper): required → valid ObjectId → branch exists (`isDeleted: false`) → branch is `isActive: true`.

Worked test flow (mirrors what was actually run live to verify this):

1. `POST /user/create-branch-admin` with `branchId: "000000000000000000000000"` (well-formed but non-existent) → **404** `"Branch not found"`.
2. `POST /user/create-staff` with `branchId: "not-a-valid-id"` → **400** `"Invalid branch ID"`.
3. Create a real active branch (`{{branchId}}`) and a STAFF/BRANCH_ADMIN on it — succeeds normally.
4. `PUT /branch/update/{{branchId}}` with `{ "isActive": false }` → branch is now deactivated.
5. `POST /user/create-staff` targeting `{{branchId}}` → **400** `"This branch is deactivated and cannot be assigned"`.
6. `POST /user/create-branch-admin` targeting `{{branchId}}` → same 400.
7. `PUT /user/update-staff/{{staffId}}` with `{ "branchId": "{{branchId}}" }` (reassigning an existing user, on a different branch, back into the now-deactivated one) → same 400.
8. `PUT /user/{{staffId}}` (generic endpoint) with `{ "branchId": "{{branchId}}" }` → same 400.
9. `PUT /user/{{staffId}}` with `{ "role": "BRANCH_ADMIN", "branchId": "{{branchId}}" }` (promotion into a deactivated branch) → same 400.
10. `PUT /branch/update/{{branchId}}` with `{ "isActive": true }` → reactivate, and all of the above start succeeding again.

All ten steps were run live against a real dev database during implementation and produced exactly the results listed above.

---

## Final Checklist

- [ ] Authentication (login, logout)
- [ ] SUPER_ADMIN profile (get own, edit own, own password, own image)
- [ ] Get user by id (new)
- [ ] User creation (BRANCH_ADMIN, STAFF)
- [ ] User creation rejects invalid/non-existent/deactivated branch (new)
- [ ] User editing (BRANCH_ADMIN, STAFF)
- [ ] Password reset (BRANCH_ADMIN, STAFF)
- [ ] User activation/deactivation (= soft delete)
- [ ] Deactivated user cannot log in
- [ ] `isActive` filter on user listing (new)
- [ ] Role/branch assignment (generic update endpoint)
- [ ] Branch reassignment rejects invalid/non-existent/deactivated branch (new)
- [ ] User image (own + another user's)
- [ ] Branch creation (with new code/email/phone format validation)
- [ ] Branch update
- [ ] Branch activation/deactivation (= soft delete)
- [ ] Deactivated branch excluded from listings by default; visible via `includeInactive=true` (new)
- [ ] Deactivated branch rejects new user assignment (new)
- [ ] Branch logo
- [ ] Login/logout history
- [ ] JWT security (no token, invalid token, valid token)
- [ ] Unauthorized access (BRANCH_ADMIN and STAFF denied on every privileged action, including the new `GET /user/:id`)
