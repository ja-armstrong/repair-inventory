# Spec: The admin role; admin-panel user & role management; no more bootstrap manager

Three linked changes:

1. **The admin role**: a third user role, "admin" — today identical to
   manager in powers, reserved for later functionality. One predicate
   (`hasManagerPowers`) owns every manager-power check; no feature logic
   compares role literals.
2. **Admin-panel user management**: the owner's panel (ADMIN_KEY) lists
   users, creates them, changes roles, deactivates/reactivates, and mints
   login links — the write rules shared with the manager API through ONE
   core per action.
3. **No more bootstrap manager**: with the panel able to create users and
   mint login links, the auto-provisioned first manager is removed —
   `BOOTSTRAP_MANAGER_EMAIL` is gone from the .env catalog; a fresh or wiped
   database has zero users and the panel is the recovery path. The API
   console runs as the first active manager-or-admin instead of the
   bootstrap manager.

## Requirements

- `Role = "admin" | "manager" | "tech"`; `hasManagerPowers` covers manager +
  admin; every former `role === "manager"` comparison (server and web) goes
  through it. The users.role CHECK gains 'admin' (0022 rebuild).
- Cores in `auth/users.ts`: `createUser`, `changeUserRole`, `setUserActive` —
  actor is the signed-in manager on the API, null on the admin panel (the
  event carries no actor plus `via: "admin panel"`). Last-active guard counts
  manager POWERS (manager or admin).
- Admin routes (key-gated): `GET /users`, `POST /users`,
  `PATCH /users/:id/role`, `PATCH /users/:id/active`,
  `POST /users/:id/login-link` (same 15-minute single-use token as the
  public flow; delivered through the email plug AND returned — the panel is
  how a panel-created user gets in when email is not configured; refused for
  deactivated users).
- Bootstrap removal: no provisioning at startup or after a wipe (the clear
  response names the recovery path); no `BOOTSTRAP_MANAGER_EMAIL` catalog
  entry or validation; the API console refuses with a clear message when no
  active manager/admin exists.
- Web: `AdminUsersPage` (create form, role select per row, deactivate/
  reactivate, send-login-link with the URL shown), nav + overview card.
- Tests: harness seeds its default manager DIRECTLY (no provisioning); the
  bootstrap-specific tests are replaced by the new story — wiped database →
  panel create → login link → redeem → real admin powers.

## Non-goals

- No admin-only functionality yet ("atm no difference to a manager") — the
  separation is in name and the one predicate seam.
