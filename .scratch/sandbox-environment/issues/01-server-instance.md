# 01 — Sandbox server instance: second context, mount at /sandbox

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/sandbox-environment/spec.md` (decisions 1, 2, 4).

The foundation ticket: everything else in the feature hangs off this. No
client work, no auth changes, no admin changes here — only the server-side
existence of a second, fully-wired instance.

## Requirement

- `AppContext` (`server/domain.ts`) grows the seams the sandbox needs, each
  an explicit field with a prod default — never a global:
  - cookie names for the user session and the admin session (today the
    constants `SESSION_COOKIE` in `server/domains/auth/session.ts` and
    `ADMIN_COOKIE` in `server/domains/admin/auth.ts` — move them behind the
    context; prod keeps the current names, sandbox uses `sandbox_session`
    and `sandbox_admin_session`, hard-derived).
  - the mount prefix (empty string for prod, `/sandbox` for sandbox) — used
    by ticket 03 for login links; introduce the field here so the context
    shape is final.
- `server/index.ts` opens a second database at
  `path.join(dirname(dbPath), "sandbox.sqlite")`, runs `migrate` on it with
  the same clock, builds a second app via the existing `createApp` factory,
  and mounts it: `app.use("/sandbox", sandboxApp)`. Express prefix-strips,
  so every domain route registers unchanged.
- The sandbox sub-app needs the same static/SPA fallback the main app has
  (serve `web/dist` `index.html` for GETs under `/sandbox` that are not
  `/sandbox/api...`), so deep links like `/sandbox/batches` load the shell.
  One dist, shared assets at their existing absolute `/assets` paths.
- `GET /sandbox/health` answers from the sandbox instance (trivially, via
  the mount) and the startup console line names BOTH database paths loudly.
- `web/vite.config.ts`: one new proxy entry `"/sandbox":
  "http://localhost:3000"` so dev reaches the same-process mount. In
  production the mount is on the main listener directly — nothing else to
  do. `scripts/dev.mjs` needs no change (same process).
- Verify the audit scheduler and any other timer registration is
  instance-scoped (per-context), not a shared module singleton — the
  sandbox DB must get its own scheduler ticks, and AGENTS.md forbids hidden
  shared state.

## Acceptance

- supertest against the main app: `/sandbox/api/...` routes hit the sandbox
  DB; `/api/...` routes hit the prod DB; a write in one never appears in
  the other.
- Cookie names differ between the two instances (set-cookie inspection).
- Both DBs are migrated at startup; both health routes answer.
- `npm run dev` serves the prod app at `/` and the sandbox app at
  `/sandbox` through the one Vite port.

## Standing docs

Update any line this change invalidates (`README.md` run/backup sections,
`docs/logic-map.md`, `docs/data-model.md` for the second DB file) in the
same change.

## Comments

### 2026-10-06 — implemented

- **Context seams** (`server/domain.ts`): `AppContext` grows three required
  fields — `sessionCookie`, `adminCookie`, `mountPrefix` — plus six named
  constants: prod (`session` / `admin_session` / `""`) and sandbox
  (`sandbox_session` / `sandbox_admin_session` / `/sandbox`), the sandbox
  values hard-derived, not configurable. No globals, no optional-field
  fallbacks: every context builder states its values.
- **Cookie helpers take the name** (`auth/session.ts`, `admin/auth.ts`):
  `readSessionCookie` / `setSessionCookie` / `clearSessionCookie` and
  `setAdminCookie` / `clearAdminCookie` / `requireAdmin` now take the cookie
  name (from `ctx.sessionCookie` / `ctx.adminCookie`) instead of reading the
  deleted module constants `SESSION_COOKIE` / `ADMIN_COOKIE`. Call sites
  updated in `auth/index.ts` (logout, double-submit re-redeem, redeem) and
  `admin/index.ts` (session open/close, requireAdmin wiring, and the API
  console's self-dispatch cookie header — it now uses the dispatching
  instance's own cookie name).
- **Entrypoint** (`server/index.ts`): opens a second database at
  `path.join(dirname(dbPath), "sandbox.sqlite")`, runs the same `migrate`
  with the same clock (first run is an empty migrated DB — no restore, no
  seeding), builds a second app via the same `createApp`, and mounts it
  `app.use("/sandbox", sandboxApp)` BEFORE the production static/SPA
  fallback is attached — the fallback only excludes `/api` paths, so mounted
  later it would swallow `/sandbox/api/...` with the SPA shell. The
  static/SPA serving was extracted into one local `serveWebClient(app)`
  helper called for both instances (one dist; assets stay at absolute
  `/assets` paths answered by the prod mount; inside the sub-app Express has
  prefix-stripped, so one `"/api"` check covers both). The startup console
  now names BOTH database paths loudly.
- **Audit scheduler verified instance-scoped**: `audits/schedule.ts` is pure
  functions — there are no timers anywhere in the server (the only
  `setTimeout` is the admin restart's respond-then-exit, which is process
  semantics by design, not shared scheduler state). Each instance's calendar
  runs off its own database per request; documented in the logic map.
- **Harness** (`server/tests/harness.ts`): builds the sandbox context the
  same way the entrypoint does (second temp SQLite, migrated, sandbox cookie
  constants, mounted at `/sandbox` on the main app), seeds a sandbox manager
  alongside the prod one, and exposes `harness.sandbox` (`db`, `dbPath`,
  own email plug) plus `loginAsOnSandbox` (the real login flow through
  `/sandbox/api/...`). The harness stays the single seam.
- **Tests** (`server/tests/sandbox-instance.test.ts`, 4 tests): both health
  routes answer with migrated counts; both databases carry the migration
  list; a user created through `/api` exists only in the prod DB and one
  created through `/sandbox/api` only in the sandbox DB (write isolation via
  the real HTTP surface); admin-session and user-session set-cookie names
  differ between the instances. One pre-existing-pattern adjustment:
  `admin.test.ts`'s restore-swap block manages its own cleanup and now also
  closes the sandbox handle before deleting the temp dir (Windows refuses
  `rmSync` on an open file).
- **Vite** (`web/vite.config.ts`): one proxy entry `"/sandbox":
  "http://localhost:3000"`. `scripts/dev.mjs` verified unchanged — it spawns
  one server process, so the mount rides the existing listener.
- **Checks**: `npm test` 571/571 across 31 files (567 before this ticket +
  4 new), `npm run typecheck` clean on both projects. Live smoke of
  `server/index.ts` confirmed the two-path startup lines, both health
  routes answering 200 with 26 migrations, and `sandbox.sqlite` created
  beside the prod file.
- **Standing docs updated in the same change**: `README.md` (new "The
  sandbox environment" subsection under Run; Backup section now states
  production data is one file and the sandbox file never needs backing up),
  `docs/logic-map.md` (domain registry: every domain registers twice, mount
  order rationale; new "Instance context" infrastructure entry; admin-gate
  and session-route rows name the per-instance cookie),
  `docs/data-model.md` (storage intro: two databases, one schema, no
  crossing).

### 2026-10-06 — defect found and fixed: the bare `/sandbox` proxy entry white-screened dev

- **Symptom** (user report): `rmshost.local/sandbox` was a white screen in
  `npm run dev`. Feedback loop: a live browser tab on `http://localhost/sandbox`
  — DOM empty (`[generic] ""`), title stuck at "RMS", and exactly one failed
  request: `GET /assets/index-DK8DC5yC.js → 404`.
- **Cause**: this ticket's Vite proxy entry `"/sandbox": "http://localhost:3000"`
  proxied the sandbox DOCUMENTS to Express, which serves the BUILT
  `web/dist/index.html`. That HTML's absolute `/assets/*` script URL then
  resolved against Vite (port 80), which does not serve built assets — and
  Vite's SPA-fallback deliberately does not answer `Sec-Fetch-Dest: script`
  requests, so the browser got 404 while curl got a misleading 200 (the
  HTML fallback). React never mounted. Production (`npm start`, one origin)
  was never affected, which is why the harness and the port-3000 smokes
  passed.
- **Fix** (`web/vite.config.ts`): proxy only the sandbox API surface —
  `"/sandbox/api"` and `"/sandbox/health"` — and let Vite's SPA fallback
  serve the DEV client for `/sandbox` documents. The client derives
  `isSandbox` from the path (ticket 02's seam works unchanged), and every
  sandbox fetch lands on `/sandbox/api/*`, which is proxied. One dist in
  production, dev client + HMR in dev — same URL, both modes.
- **Regression seam**: none honest exists — supertest never sees Vite, and a
  config-file-content pin would not test the behavior. The regression check
  is the browser loop itself: reload `http://localhost/sandbox` after the
  fix → title `RMS (SANDBOX)`, SANDBOX banner, login page rendered,
  `/sandbox/api/auth/me` answered 401 (logged-out check) by the sandbox
  instance. Same decision pattern as ticket 06's client-seam check.
- `npm run typecheck` clean after the change; `npm test` unaffected
  (config-only change, tests do not read `vite.config.ts`).
