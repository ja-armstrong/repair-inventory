# 04 — Sandbox admin panel semantics

Status: ready-for-human
Labels: ready-for-human
Blocked by: 01, 02

Implements `.scratch/sandbox-environment/spec.md` (decision 8).

The mounted sandbox app already exposes `/sandbox/admin` with the same
`ADMIN_KEY` — this ticket makes every panel tool state WHICH database it is
pointing at, and fixes the tools whose behavior must differ.

## Requirement

- **Backup**: the sandbox panel's backup saves the SANDBOX database as
  `sandbox-YYYYMMDD-HHMMSS.sqlite` in the same `data/backups/` folder (the
  prod panel keeps its existing filename). The download anchor flows
  through the ticket-02 API seam.
- **Clear the database**: wipes the sandbox DB only; the pre-clear safety
  backup also gets the `sandbox-` prefix. Same `ERASE ALL DATA` phrase.
- **SQL console / API console / System info**: already sandbox-scoped via
  the mount — verify (system info must show the sandbox DB path and size;
  the API console runs as the sandbox bootstrap manager).
- **Environment page**: shows the same shared `.env` keys everyone edits,
  PLUS the sandbox's resolved DB path (and mount) shown read-only, so the
  trainer can see exactly which file the sandbox is.
- **Restart**: still gated by `ALLOW_RESTART`; the button's description must
  say it restarts the WHOLE process — both environments die together.
- The sandbox admin session cookie is `sandbox_admin_session` (ticket 01
  seam) — verify the key login and lock work independently of a prod admin
  session in the same browser.

## Acceptance

- From the sandbox panel: backup produces a `sandbox-*.sqlite` file whose
  contents are the sandbox DB (a row created only in the sandbox appears in
  it; a prod-only row does not).
- Clear empties only the sandbox DB; prod row counts unchanged.
- Every sandbox admin page visibly names its target database — no page
  where the trainer must guess.

## Standing docs

`README.md` admin-panel section: note the sandbox panel's backup naming and
restart scope.

## Comments

### 2026-10-06 — implemented

- **Backup filename stem is now an instance seam** (`server/domain.ts`):
  `AppContext.backupStem` plus named constants `PROD_BACKUP_STEM`
  ("repair-inventory") / `SANDBOX_BACKUP_STEM` ("sandbox"), wired in
  `server/index.ts` and the harness exactly like the cookie names.
  `createBackup` (`admin/backups.ts`) takes the stem as an explicit parameter
  — no derivation from the database filename, no instance sniffing inside the
  domain. Every backup path in the admin domain (one-click backup, the
  pre-clear backup, the pre-restore backup, the SQL console's pre-write
  backup) goes through the same `ctx.backupStem`, so the sandbox panel saves
  `sandbox-YYYYMMDD-HHMMSS.sqlite` into the SAME `data/backups/` folder while
  the prod panel's filename is byte-for-byte unchanged. The same-second
  collision suffix (`-2`, …) is unchanged and applies to both stems.
- **Clear the database**: no code change needed beyond the stem — the route
  already runs `createBackup` → `wipeAndRecreate` on `ctx.db`/`ctx.dbPath`,
  so the pre-clear safety backup automatically gets the `sandbox-` prefix
  and the wipe hits only the sandbox database. Same `ERASE ALL DATA` phrase
  (the danger rule does not loosen for the sandbox).
- **API console had one real bug, now fixed** (`admin/index.ts`): the
  self-dispatch URL was `http://127.0.0.1:<port>${target}`, which in the
  sandbox would land on the PRODUCTION app with a sandbox session cookie —
  wrong database. It now dispatches to
  `http://127.0.0.1:<port>${ctx.mountPrefix}${target}` (prod prefix is "" so
  prod behavior is unchanged), running as the sandbox's first active
  manager with a `sandbox_session` cookie.
- **Environment page** (`GET /env`): the response now carries read-only
  `instance: { dbPath, mountPrefix }` — the panel's own database file and
  mount, resolved by the composition root. Both instances return it (prod
  shows its own), so the page always names its target; the client
  (`AdminEnvPage.tsx`) renders it as a read-only table above the .env keys
  with a note that the keys below are shared by both instances.
- **Restart description** (`AdminEnvPage.tsx`): in the sandbox the warning
  above the button now states the WHOLE server process restarts — sandbox
  and production stop and come back together (still gated by
  `ALLOW_RESTART`; the gate itself is process-level and unchanged).
- **Every sandbox admin page names its database** (`AdminLayout.tsx` +
  `styles.css`): the sandbox admin header reads "RMS — Admin (SANDBOX)" and
  every page carries an explicit line that the tools act on the SANDBOX
  database only, with System info / Environment pointing at the exact file.
  `AdminBackupPage.tsx` now derives the filename it advertises from
  `isSandbox` (it used to hard-code `repair-inventory-…`, which would have
  lied in the sandbox).
- **SQL console / system info**: verified sandbox-scoped via the mount — no
  code change; both read `ctx.db` / `ctx.dbPath`. System info reports the
  sandbox db path + size, pinned by test.
- **Tests** (`server/tests/sandbox-admin.test.ts`, 6 tests): sandbox backup
  produces `sandbox-*.sqlite` holding the sandbox-only row and not the
  prod-only row (and the prod backup in the same folder holds the reverse);
  clear wipes only the sandbox (prod row counts unchanged, pre-clear backup
  `sandbox-`-prefixed, wrong phrase refused); system info reports the
  sandbox dbPath/size; env shows the shared keys plus
  `instance.dbPath === sandbox.sqlite` and `mountPrefix === "/sandbox"`;
  the API console dispatched from the sandbox panel returns the SANDBOX
  user list over a real HTTP listener and leaves zero sessions in the
  sandbox db; admin-key login/lock independence — one cookie jar holds
  `admin_session` and `sandbox_admin_session` simultaneously, a prod-only
  session grants nothing on the sandbox panel, locking either panel leaves
  the other open, and a wrong-key sandbox attempt disturbs nothing in prod.
  Full suite 583/583 across 33 files; `npm run typecheck` clean (server +
  web). Live smoke on a spare port with a throwaway `DB_PATH`: sandbox
  login 204, system/env/backup/clear all sandbox-scoped with
  `sandbox-20261006-HHMMSS.sqlite` files landing in the shared backups
  folder.
- **Standing docs updated in the same change**: `README.md` (the stale
  "user-facing pages arrive with the web client work" line replaced — the
  full UI with banner lives at `/sandbox`; backup section notes the
  `sandbox-` naming; a new paragraph on the sandbox panel's backup naming
  and whole-process restart scope), `docs/logic-map.md` (the instance-seam
  paragraphs now list the backup stem; `GET /backup`, `GET /env`, and
  `POST /api-console` rows updated).
