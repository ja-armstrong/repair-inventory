# 18: Admin panel — settings, backups, and the danger zone

**What to build:** A separate admin surface for the owner: routes under `/admin`, its own layout, and its own authentication — an `ADMIN_KEY` from `.env`, entered once and held in a separate admin cookie. Zero links from the main app's navigation; if `ADMIN_KEY` is unset the entire surface is disabled (404) with a loud console warning. Features:

- **Global settings editor**: every app setting (audit interval, price expiry, label size, …) with server-side validation and `setting.updated` events.
- **Database backup**: one click → consistent online backup (SQLite backup API / WAL checkpoint, per ADR-0001's "backup path obvious in the UI"), downloaded as a timestamped file.
- **Clear the database**: requires typing a confirmation phrase AND forces a backup first (saved to `data/backups/` and offered for download); the action is logged to the server console with timestamp.
- **Restore from backup**: upload a `.sqlite` file → `integrity_check` + migration-state sanity check → auto-backup of the current database → atomic swap.
- **SQL console**: read-only SELECTs by default; an explicit per-session write mode that requires typed confirmation and an automatic pre-write backup. This keeps a single reviewed door to raw SQL instead of scattered bypasses.
- **System info**: row counts per table, applied-migration list, app version/uptime.

Danger rules (per the AGENTS.md review standard): every destructive action is (1) backed up first, (2) typed-confirmed, (3) console-logged with timestamp. No direct filesystem/database bypass scripts — the panel is the reviewed door.

**Blocked by:** None beyond the current suite (independent of ticket 12; do not touch the reports domain).

**Status:** ready-for-human

- [x] `/admin` surface with its own key-based auth, separate cookie, disabled loudly when ADMIN_KEY is unset; main-app sessions grant nothing there
- [x] Settings editor validates and records events; invalid values are rejected loudly
- [x] One-click consistent backup download (timestamped filename); restore validates integrity + migration state before an auto-backed swap
- [x] Clear requires typed confirmation, forces a backup first, and is console-logged; SQL console is read-only by default with a confirmed, auto-backed write mode
- [x] System info shows row counts, applied migrations, version/uptime
- [x] Admin API tests at the seam: auth gate (no key, wrong key, right key), backup-then-clear ordering, restore validation rejections, read-only default
- [x] Admin UI: separate layout, each action with its confirmation flow

## Comments

- Domain: `server/domains/admin/` — `index.ts` (HTTP edge + constants), `auth.ts`
  (key check, `admin_session` cookie, failure limiter, gate), `backups.ts`
  (createBackup / validateBackupFile / wipeAndRecreate / applyPendingRestore),
  `sql.ts` (single-statement + SELECT shaping). Registered FIRST in
  `server/bootstrap.ts`: the auth domain's `/api` router runs `requireSession`
  on every `/api/*` path, so `/api/admin` must be matched before it.
- Auth model: `ADMIN_KEY` from `.env` read at registration (unset → catch-all
  404 under `/api/admin`; the loud startup warning is in `server/index.ts`).
  Correct key (constant-time compare via SHA-256 digests) mints a random token
  held in process memory, stored in the dedicated `admin_session` cookie
  (400-day max age). Restart invalidates tokens. Failed logins are rate-limited
  to 5 per minute per IP (429). A main-app session cookie is never read here.
- Backup: `db.backup()` (SQLite online backup API — consistent under writes),
  saved to `<db dir>/backups/` and streamed as
  `repair-inventory-YYYYMMDD-HHMMSS.sqlite` (clock-stamped).
- Clear: typed phrase `ERASE ALL DATA` verified server-side → backup FIRST →
  drop every table (incl. `migrations`) → re-run the migration runner →
  re-provision the bootstrap manager → console-log with timestamp → response
  carries the backup filename. One schema-building path, no parallel "fresh"
  script.
- Restore (the chosen mechanism, restart-safe): upload as raw
  `application/octet-stream` (`?filename=` must end `.sqlite`) → staged copy
  validated (`integrity_check` + `migrations` table + applied set is a prefix
  of known migrations) → current DB auto-backed-up → staged file + marker
  written → `applyPendingRestore(dbPath)` at the next start (in
  `server/index.ts`, before the DB opens) re-validates, backs up the current
  file once more, replaces the file, and the normal startup migration applies
  any missing migrations. In-process hot swap was rejected deliberately: every
  domain's prepared statements would be stranded on the dead handle.
- SQL console: single-statement SELECT only by default (chained statements and
  non-SELECT rejected with a clear message; SQL errors verbatim). Write mode is
  per admin session, enabled by typing `ALLOW WRITES`, and every write
  execution takes an automatic pre-write backup (a lone SELECT in write mode
  reads only, so no backup). Every executed statement is console-logged with a
  timestamp.
- AppContext gained `dbPath` (backup/restore/clear need the file location);
  `migrate.ts` exports `knownMigrationNames()` for restore validation;
  `validateSettingValue()` in parts/settings.ts is now the single
  settings-validation rule used by both the manager route and the admin route;
  `provisionBootstrapManager` is exported so a cleared database is never a
  locked one. Harness: additive `adminKey` option + `dbPath` handle.
- Web: `web/src/admin/` (own layout + login gate + nav, five pages). No links
  from the main app; Vite dev proxy already covers `/api`.
- Tests: `server/tests/admin.test.ts` (28 tests) at the HTTP seam, including
  the startup swap scenario (closes the live handle, runs
  `applyPendingRestore`, reopens the file) and backup-content assertions that
  pin the backup-before-wipe ordering. Full suite 287/287.
