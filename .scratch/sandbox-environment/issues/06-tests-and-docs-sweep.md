# 06 — Sandbox: full test coverage and standing-docs sweep

Status: ready-for-human
Labels: ready-for-human
Blocked by: 02, 03, 04, 05

Implements `.scratch/sandbox-environment/spec.md` in full — the closing
ticket. Earlier tickets updated doc lines they invalidated as they went;
this one makes the documentation whole and proves the feature end to end.

## Requirement

### Tests (through `createTestHarness()` — the single test seam)

- Mount isolation: `/api/...` and `/sandbox/api/...` hit different
  databases; a write in one never appears in the other; both migrate at
  startup.
- Cookie isolation: the two instances set DIFFERENT cookie names; a prod
  session and a sandbox session coexist in one Cookie header without
  confusing either server.
- Sandbox login: link request → console-logging plug captured the link,
  nothing sent via Resend even when `RESEND_KEY` is set; link URL carries
  the `/sandbox` prefix; redeem yields a sandbox session.
- Admin panel scoping: sandbox backup filename prefix; clear wipes only the
  sandbox DB; system info reports the sandbox path.
- Reset: valid picked file, valid upload, corrupted file refused BEFORE any
  swap, pre-reset auto-backup exists, sandbox sessions dead after
  reset+restart, empty-backups loud state.
- Client seam: the built bundle serves both `/` and `/sandbox/batches` from
  one dist (build once in CI-able form or assert on the seam module's
  contract — pick the cheapest honest check).

### Standing docs — full sweep

- `README.md`: a "Sandbox" section for the non-developer maintainer — what
  `/sandbox` is, that it never emails, how to reset it, that restart kills
  both.
- `docs/logic-map.md`: the second instance's routes/mount and which DB each
  serves.
- `docs/data-model.md`: the second SQLite file and the no-cross-writes
  invariant.
- `docs/manual.md`: the trainer flow top to bottom, literal statements —
  create trainee users, run a practice batch, reset from a backup.
- `CONTEXT.md`: only if a new domain term earned its way in (likely not —
  the sandbox is infrastructure, not shop vocabulary; say so if skipping).

### Final gate

- Full `npm test` green, `npm run typecheck` clean (both projects).
- Every ticket file in this directory gets its `## Comments` entry as it
  lands; this ticket's comment records the suite count and the review
  verdict against AGENTS.md's standard (no silent fallbacks, every seam an
  explicit contract).

## Comments

### 2026-10-06 — implemented (closing sweep)

- **Test inventory — nothing genuinely missing, so nothing new was written.**
  Every item on this ticket's list was already pinned by tickets 01–05, each
  through `createTestHarness()`: mount isolation / write isolation / both DBs
  migrate (`sandbox-instance.test.ts`, 4 tests); cookie names differ AND one
  cookie jar holds prod + sandbox sessions simultaneously
  (`sandbox-instance` + `sandbox-auth.test.ts`); sandbox login flow —
  prefixed link, console-only plug with `RESEND_KEY` set (zero fetch calls),
  redeem into a `sandbox_session` (`sandbox-auth.test.ts`, 6 tests); admin
  scoping — `sandbox-` backup filename, clear wipes only the sandbox, system
  info reports the sandbox path, env shows the instance, key-session
  independence (`sandbox-admin.test.ts`, 6 tests); reset — picked file,
  upload, corrupt/wrong-schema refused BEFORE any swap or auto-backup,
  auto-backup exists, sessions dead after reset+restart, empty-backups loud
  state (`sandbox-reset.test.ts`, 11 tests). Adding more would duplicate; no
  fake coverage created.
- **Client-seam decision — recorded, not faked.** The honest check for "one
  dist serves both `/` and `/sandbox/batches`" is build+smoke: the seam
  module (`web/src/sandbox.ts`) derives `isSandbox` from
  `window.location` at module load, so a unit test would need a DOM harness
  the web project does not have, and stubbing the derivation would test the
  stub. Ticket 02 verified it that way; this ticket RE-RAN the check against
  the final tree: `npm run build` → `GET /` and `GET /sandbox/batches` both
  200 serving the SAME assets (`index-DK8DC5yC.js` / `index-CHnmMhSK.css`);
  `GET /sandbox/api/auth/me` answers 401 (the sandbox API route, not the SPA
  shell); `GET /sandbox/health` 200 from the sandbox DB; the bundle contains
  the seam derivation, the SANDBOX banner, and the `RMS (SANDBOX)` title.
  Spare port 3499 + throwaway `DB_PATH`, process tree killed, temp dir
  removed. (The smoke's startup line also showed the plug seam live: with
  the repo's real `RESEND_KEY` set, prod selected Resend while the sandbox
  still hard-derives the logging plug.)
- **Standing-docs sweep, per file:**
  - `README.md` — the sandbox story was already spread across "The sandbox
    environment" (Run), "Logging in", "Backup", "Reset the sandbox (the
    trainer's flow)", and the sandbox-panel paragraph. One incoherence
    fixed: that paragraph sat mid-way through the "Other admin panel tools"
    bullet list (between **Environment** and **Clear**), breaking the list
    in two. The list is now its own `## Other admin panel tools` section and
    the sandbox paragraph follows it. No stale lines found; the full story
    (what /sandbox is, never emails, trainer reset flow, restart kills
    both) was verified present and consistent.
  - `docs/logic-map.md` — the Instance-context paragraph listed every
    context seam EXCEPT the email plug (added by ticket 03; its own
    paragraph existed but the list was stale): fixed. Added one sentence
    documenting the client side of the same seam (`web/src/sandbox.ts`:
    `isSandbox` / `apiBase` / `basename`, one dist, no domain branching) —
    the second instance's routes/mount and per-DB story were already
    consolidated in the Domain registry and the admin/health route tables.
  - `docs/data-model.md` — already current: "Two databases, one schema"
    names both files (`data/repair-inventory.sqlite`, `data/sandbox.sqlite`)
    and states the no-cross invariant ("no table, row, session, or cookie
    crosses between the two instances"). No change needed.
  - `docs/manual.md` — had NO sandbox section: added **section 14, "The
    sandbox — a practice copy"** (literal statements, no analogies): what
    /sandbox is and that nothing done there touches shop data; the banner
    and tab title; the login flow with the never-emails / console-links /
    `/sandbox`-prefix facts; creating trainee users via the sandbox panel's
    Users & roles; practicing real flows (batch, devices, parts, approval,
    PO receipt); the trainer's reset flow end to end (backup file exists →
    sandbox panel Reset → pick or upload → validation first → auto-backup
    shown → staged → swap at restart → everyone logged out, trainee users
    gone); the panel's sandbox-only scoping and the deliberately-absent
    Restore card; and that one restart stops and starts both copies. The
    former section 14 ("Who can do what") is now 15 — no cross-references
    to renumber. Incidental fix in the same file: the section-15 table's
    header/separator row was merged with the first data row (broken
    markdown since before this feature); split so the table renders.
  - `CONTEXT.md` — **deliberately unchanged.** The sandbox is
    infrastructure (a second mount of the same app), not shop vocabulary:
    no new domain term entered the shop's language, so nothing earned an
    entry. Skipping it is the decision, not an omission.
- **Flagged for triage (latent PROD warts, recorded NOT fixed — prod
  behavior is out of this feature's scope; observed by ticket 05,
  pre-existing):**
  1. Prod `POST /restore` validates its upload in place and can leave
     `restore-upload-…sqlite-{wal,shm}` debris in `data/backups/` after a
     SUCCESSFUL stage (only the rejected case is test-pinned). The sandbox
     reset routes avoid this (validation sidecars removed before the
     rename); prod's route should be aligned.
  2. Prod's staged-restore file name skips `uniqueBackupName`: two restores
     staged within the same second overwrite the earlier staged file. The
     sandbox stages under its own stamped names; prod should use the same
     uniqueness guarantee.
  A maintainer can turn each into a ticket.
- **Final gate:** `npm test` — **594/594 across 34 files, exit 0** (the
  suite includes the other agent's in-flight files, run as-is and untouched
  by this ticket); `npm run typecheck` — exit 0, both projects
  (`tsconfig.json` + `web`). Tickets 01–05 verified: each carries a dated
  2026-10-06 `## Comments` and `Status: ready-for-human`.
- **Gaps found in earlier tickets' coverage:** none against this ticket's
  list. Two observations for the record: (a) no test pins the sandbox SPA
  fallback serving `/sandbox/batches` as HTML — that is exactly the
  client-seam build+smoke above (a supertest-level pin would need the built
  dist, which unit tests deliberately do not build); (b) the sandbox
  instance's domain flows (batches, parts, POs, audits) run through the same
  domain cores the prod tests exercise — per spec, the sandbox differs only
  at the seams, and the seams are the pinned surface.
- **Review verdict against AGENTS.md's standard — each seam walked and
  confirmed an explicit contract (verified in `server/domain.ts`,
  `server/index.ts`, `server/tests/harness.ts`, `web/src/sandbox.ts`, not
  just in ticket prose):**
  - **db** — `AppContext.db` + `dbPath` are required fields; both
    composition roots (entrypoint, harness) open and migrate each database
    explicitly; no domain can see the other instance's handle. Invariant
    pinned by test (write isolation both directions).
  - **cookie names** — `sessionCookie` / `adminCookie` required context
    fields; prod and sandbox values are named constants, hard-derived, not
    configurable. Helpers take the name; no module-level constant survives.
    Pinned: set-cookie names differ; one jar holds both sessions; cross-
    instance requests 401.
  - **mountPrefix** — required field (`""` / `"/sandbox"`), used by the ONE
    shared login-link builder and the API console's self-dispatch; no route
    sniffs its own mount. Pinned: prefixed/unprefixed links, LAN Origin
    case, sandbox API-console dispatch landing on the sandbox app.
  - **emailPlug** — required field picked once by the composition root;
    prod selection is `createProdEmailPlug()` (Resend iff `RESEND_KEY`);
    the sandbox context unconditionally gets `createLoggingEmailPlug()` —
    a sandbox that emails is a defect, not a setting. Pinned: with
    `RESEND_KEY` set, exactly one send (prod's) and the sandbox link in the
    logging plug; live smoke showed the same selection with the real .env.
  - **backupStem** — required field (`"repair-inventory"` / `"sandbox"`);
    `createBackup` takes the stem as a parameter — no filename derivation,
    no instance sniffing. Pinned: `sandbox-*.sqlite` contents are the
    sandbox's rows (and the prod backup the reverse).
  - **stagedRestore** — `StagedRestoreSeam` with per-instance
    `markerStem` / `preSwapStem` / `label` and explicit booleans for which
    swap surfaces register (`restoreRoute` prod-only, `resetRoutes`
    sandbox-only); `applyPendingRestore` is called once per instance with
    that instance's seam. Pinned: own-slot staging, prod marker untouched,
    prod byte-for-byte untouched, the 404 tombstone for the removed sandbox
    restore route, and the startup swap + dead sessions.
  - **client `isSandbox` / `apiBase`** — one module, derived once at load,
    re-exported to the two fetch sites (`api.ts`, `admin/api.ts`) plus the
    two swept escapees (backup anchor, ReportsPage CSV); the sweep for seam
    escapes was exhaustive and is documented in ticket 02. Verified at the
    bundle level by the smoke above.
  No silent fallbacks, no stubs, no TODOs found on any seam: every
  instance-specific value is stated by its composition root, and every
  refusal path (corrupt source, wrong key, missing file, disabled surface)
  fails loudly. The feature meets the review standard.
