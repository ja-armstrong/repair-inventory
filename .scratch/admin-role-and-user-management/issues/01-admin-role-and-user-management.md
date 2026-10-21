# 01 — Admin role, admin-panel user management, bootstrap manager removed

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/admin-role-and-user-management/spec.md`.

## Comments

### 2026-10-02 — implemented

- **Vocabulary + one predicate** (`auth/session.ts`): `Role = "admin" |
  "manager" | "tech"`; `hasManagerPowers` is the ONE seam every manager-power
  check goes through. All former literal comparisons replaced, server-side:
  `requireManager` (auth/session.ts), the Price Add Limit gate + amendment +
  tech-removal gate (batchparts/attach.ts), `changeDevicePriceLimit`
  (batches/lifecycle.ts — its actor type tightened to `role: Role`),
  `setPartPrice`'s Open-batch door (parts/effective-price.ts), the admin API
  console's actor check (admin/index.ts), and the users domain's guards.
- **Migration 0022** (`0022-user-admin-role.sql`): users.role CHECK gains
  'admin'. SQLite cannot ALTER a CHECK and users is a parent with ~20
  descendants, so instead of a 0015-style full cascade the migration declares
  `-- foreign-keys: disabled for this migration` (first line) and
  `db/migrate.ts` honors the marker for THAT file only: FK enforcement is
  disabled around the runner's transaction (which still wraps the file —
  half-apply rolls back), restored immediately after. The rebuild is
  in-place (`users_rebuilt` copy → drop → rename); descendant FK clauses
  reference the table by name and resolve again (verified with a scratch
  better-sqlite3 experiment BEFORE writing the migration: the deferred-FK
  alternative fails at commit — do not use it).
- **Shared write cores** (`auth/users.ts`): `createUser`,
  `changeUserRole`, `setUserActive` — allowlist/duplicate refusals, the
  last-active guard (counts manager OR admin), guarded writes, session-kill
  on deactivation, events with `via: "admin panel"` and a null actor when the
  panel acts. The manager-gated /api/users routes are thin edges over them.
- **Admin routes** (`admin/index.ts`, key-gated): `GET /users`,
  `POST /users`, `PATCH /users/:id/role`, `PATCH /users/:id/active`,
  `POST /users/:id/login-link` (15-minute single-use token, same shape as the
  public flow; delivered through the email plug AND returned in the response;
  deactivated users refused until reactivation).
- **Bootstrap manager removed**: `provisionBootstrapManager` deleted
  (auth/index.ts no longer provisions at registration); the wipe path no
  longer re-provisions — the clear response says to create users in the
  panel; `BOOTSTRAP_MANAGER_EMAIL` is gone from the .env catalog and its
  validation branch; the API console runs as the FIRST active
  manager-or-admin user and refuses with a clear message when none exists.
- **Harness** (`server/tests/harness.ts`): seeds its default manager DIRECTLY
  into the database (no env, no provisioning); `bootstrapManagerEmail` option
  removed; `DEFAULT_BOOTSTRAP_MANAGER_EMAIL` renamed `DEFAULT_MANAGER_EMAIL`
  across all test files (mechanical).
- **Tests**: `users.test.ts` — creating an admin now succeeds (was asserted
  invalid); nonsense roles still 400. `admin.test.ts` — the wipe test asserts
  ZERO users + the recovery note; the old provisioning-failure test is
  replaced by the end-to-end bootstrap story (wipe → panel create user →
  mint login link → redeem → the new admin lists users; timeline event has
  no actor + `via: "admin panel"`); deactivate/reactivate + login-link
  refusal for deactivated users. `admin-env-restart-console.test.ts` — env
  catalog expectations updated (no BOOTSTRAP key); the console-refusal test
  deactivates all users instead of unsetting an env var (and restores, since
  the describe shares a harness). `auth.test.ts` — the provisioning describe
  removed (behavior gone). Full suite 470/470; both typechecks clean.
- **Web**: `AdminUsersPage` (create form, per-row role select, deactivate/
  reactivate, send-login-link with the URL displayed), nav item + overview
  card; `AdminUser` type in admin/api.ts.
- **Docs**: README (env table, panel tools), CONTEXT.md (Admin definition),
  docs/manual.md (logging-in first-user note, admin panel sections, Who-can-
  do-what Admin sentence), docs/logic-map.md (admin route rows, cross-domain
  rows), docs/data-model.md (users invariants + 0022 in the migrations
  table).
