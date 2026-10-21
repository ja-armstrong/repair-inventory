# 05 — Reset sandbox from a backup (picker + upload)

Status: ready-for-human
Labels: ready-for-human
Blocked by: 01, 02, 04

Implements `.scratch/sandbox-environment/spec.md` (decision 5).

The trainer's flow: prod panel → Backup (file lands in `data/backups/` AND
downloads) → sandbox panel → Reset. Re-uploading a file that is already on
the server's disk is a pointless detour, so both sources exist.

## Requirement

- New sandbox-admin routes (under `/sandbox/api/admin/...` via the mount):
  - `GET` the reset sources: every `.sqlite` in `data/backups/`, newest
    first, filename + size + mtime, `sandbox-` snapshots INCLUDED (resetting
    a sandbox from an old sandbox snapshot is legitimate; label them).
  - `POST` reset: either `filename` (from the list) or an uploaded file —
    BOTH paths run the same validation as prod Restore (integrity check +
    migration history) before anything is touched.
- Order of operations, exactly the prod Restore contract: auto-backup the
  current sandbox DB FIRST (its filename is shown in the response), then
  swap the file in. The swap takes effect on the next server restart (the
  page says so, matching the existing staged-restore mechanism pointed at
  the sandbox DB path — reuse `applyPendingRestore`'s pattern; if a shared
  staging slot exists, the sandbox needs its OWN staging slot so a sandbox
  reset and a prod restore can never collide).
- The page states plainly: resetting logs out everyone in the sandbox
  (sessions live in the DB), and trainee-created users vanish.
- If `data/backups/` is empty, the list says so loudly and upload still
  works. A missing/invalid picked file fails loudly (404/400), never
  silently.
- Manual only — no schedule, no auto-reset (settled; a scheduler here is a
  defect).

## Acceptance

- Reset from a picked prod backup: after restart, the sandbox serves the
  copied data; prod DB untouched byte-for-byte; the pre-reset sandbox
  backup exists in `data/backups/`.
- Reset from an upload behaves identically.
- A corrupted or wrong-schema file is refused BEFORE the swap, with the
  sandbox DB still intact and running.
- Sessions: a sandbox session cookie held across reset+restart no longer
  authenticates (the sessions table came from the backup).

## Standing docs

`README.md`: the trainer's reset flow, written for the non-developer
maintainer.

## Comments

### 2026-10-06 — implemented

- **The staging-slot hazard, fixed at the seam** (`server/domain.ts`): new
  explicit `AppContext.stagedRestore` seam (`StagedRestoreSeam`) with named
  constants `PROD_STAGED_RESTORE` / `SANDBOX_STAGED_RESTORE`. It carries the
  instance's `markerStem` (`pending-restore` vs `pending-restore-sandbox`),
  `preSwapStem` (`pre-restore` vs `pre-restore-sandbox` — the startup
  pre-swap backup is now stem-based, so the shared `data/backups/` folder
  keeps saying WHICH database a file held; prod's names are unchanged),
  a `label` for loud startup/console messages, and two booleans for which
  swap surfaces register (`restoreRoute`: prod only; `resetRoutes`: sandbox
  only). `pendingRestoreMarkerPath(dbPath, markerStem)` and
  `applyPendingRestore(dbPath, staging)` take the seam; `server/index.ts`
  now calls `applyPendingRestore` for BOTH db paths before each is opened,
  each against its own marker — a sandbox reset and a prod restore are
  checked independently and can never cross.
- **The sandbox's stock restore route is REMOVED** (registered only under
  `ctx.stagedRestore.restoreRoute`): its reset routes supersede it, and a
  second route staging into the old shared slot is exactly how a sandbox
  restore could have been swapped into the PRODUCTION database at startup.
  The absence is an explicit 404 tombstone in the sandbox (without it the
  request fell through to the main app's session gate and answered a
  misleading 401). Prod's `/restore` is untouched — one mechanical test edit
  in `admin.test.ts` (two `applyPendingRestore` calls now pass
  `PROD_STAGED_RESTORE`; semantics and assertions unchanged).
- **Reset routes** (`server/domains/admin/reset.ts`, registered from the
  admin domain under `ctx.stagedRestore.resetRoutes`, same admin-key
  session): `GET /sandbox/api/admin/reset/sources` — every `.sqlite` in
  `data/backups/`, newest first (mtime desc, filename desc tie-break),
  filename + `sizeBytes` + `modifiedAt` + `sandboxSnapshot` label
  (`sandbox-` prefix, via `SANDBOX_BACKUP_STEM`); empty folder returns
  `{ sources: [], empty: true }` so the page says so loudly.
  `POST /sandbox/api/admin/reset` — either `{ filename }` (bare-name
  validation: no separators, no `..`, 404 when missing) or an uploaded raw
  body (`?filename=`), both unified through one staging candidate:
  validate (`validateBackupFile` — integrity + migration history) BEFORE
  anything is touched, then auto-backup the current sandbox DB via
  `createBackup(ctx.db, ctx.dbPath, ctx.clock, ctx.backupStem)` (filename in
  the response), then stage. The picked source is COPIED, never moved; the
  staged name and the marker carry the sandbox marker stem, so the two
  instances' staged files can't overwrite each other; validation's read-only
  open can leave WAL sidecars next to the candidate on Windows, so they are
  removed before the rename (a stale sidecar beside a same-named future file
  would be corruption on open). Manual only — no scheduler exists anywhere.
- **Two latent prod warts observed, NOT changed** (prod untouched per
  ticket): the prod `/restore` route (a) validates its upload in place and
  can leave `restore-upload-…sqlite-{wal,shm}` debris in `data/backups/` on
  a successful stage (its tests only pin the rejected-upload case), and
  (b) its staged-file name is built without `uniqueBackupName`, so two
  restores within the same second overwrite the earlier staged file. The
  sandbox routes avoid both; ticket 06 may want to align prod.
- **Web** (`web/src/admin/AdminResetPage.tsx`, routed at `/admin/reset`,
  nav item sandbox-only via a `sandboxOnly` flag on `NAV_ITEMS`): backup
  list with sizes/mtimes and the "(sandbox snapshot)" label, loud empty
  state (upload still works), file-upload path, an explicit acknowledgment
  checkbox ("everyone in the sandbox is logged out, trainee-created users
  vanish, and the swap happens at the next server restart"), and the
  staged-state message naming the staged file and the pre-reset backup. The
  sandbox's Danger zone no longer renders the prod-only Restore card (its
  button would only answer 404). API client types added to
  `web/src/admin/api.ts`; all calls go through the existing `apiBase` seam.
- **Tests** (`server/tests/sandbox-reset.test.ts`, 11 tests): sources list
  (order/size/mtime/labels, non-.sqlite excluded, empty-folder shape);
  pick-mode staging into the sandbox's OWN slot with the picked file,
  the prod file (byte-for-byte), and the prod marker untouched; upload-mode
  parity with no candidate/sidecar debris; missing file 404, corrupt +
  wrong-schema + traversal 400 — all refusing BEFORE the auto-backup with
  the sandbox still serving; the removed `/restore` route 404 (prod's still
  answers); auth gate (401 keyed-out, 404 key-unset); the startup swap via
  `applyPendingRestore(sandbox path, SANDBOX_STAGED_RESTORE)` — trainee SKU,
  trainee user, and sessions all gone, migrations completed by the normal
  run, `pre-restore-sandbox-` backup taken, marker consumed, prod untouched;
  and a pre-reset sandbox session cookie replayed against a fresh app on the
  restored file → 401. Full suite 594/594 across 34 files (was 583/583);
  both typechecks clean; prod restore tests pass untouched.
- **Live smoke** (throwaway port 3457 + temp `DB_PATH`, cleaned up): boot →
  prod Backup → sources list → staged reset (only `pending-restore-sandbox.json`
  appears next to the databases, never the prod marker name) →
  `/sandbox/api/admin/restore` → 404 → restart → console line
  `[admin] sandbox restore completed … (pre-swap backup: pre-restore-sandbox-…)`,
  marker consumed, and the sandbox database file then matches the chosen
  backup exactly. (One smoke hiccup was my own cleanup, not the product:
  killing the npx wrapper left the first server's child alive holding the
  sandbox WAL, which made the second boot's sidecar removal fail EPERM —
  killed the process tree, reran clean.)
- **Standing docs updated in the same change**: `README.md` (new "Reset the
  sandbox (the trainer's flow)" section; the sandbox-panel paragraph now
  names Reset and the deliberately-absent prod Restore card) and
  `docs/logic-map.md` (instance-seam list gains the staged-swap seam;
  `POST /restore` marked production-only; `GET /reset/sources` and
  `POST /reset` rows added; the shared-infrastructure context paragraph
  lists the new seam constants).
