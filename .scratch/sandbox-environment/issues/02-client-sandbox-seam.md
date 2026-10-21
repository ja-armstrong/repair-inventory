# 02 — Client sandbox seam: isSandbox, basename, API prefix, banner

Status: ready-for-human
Labels: ready-for-human
Blocked by: 01

Implements `.scratch/sandbox-environment/spec.md` (decisions 3, 10).

ONE built dist serves both environments. All sandbox awareness lives behind
one seam — no `import.meta.env` builds, no second bundle.

## Requirement

- One tiny module (e.g. `web/src/sandbox.ts`) exports `isSandbox`, derived
  ONCE at module load from `window.location.pathname` starting with
  `/sandbox`, plus an `apiBase` helper (`""` for prod, `"/sandbox"` for
  sandbox). Everything else reads it.
- `web/src/api.ts` and `web/src/admin/api.ts`: prefix every request path
  with `apiBase` at the single fetch call site in each file — the ~30
  call-sites that hardcode `/api/...` strings stay untouched.
- Sweep for request paths that BYPASS those two files and fix them through
  the same seam — known instance: the backup download anchor
  `href="/api/admin/backup"` in `AdminBackupPage.tsx`. Grep
  `href="/api`, `fetch("/api`, and `action=` to be sure nothing is missed;
  a path that escapes the seam is a defect, not an edge case.
- `web/src/main.tsx`: `<BrowserRouter basename={isSandbox ? "/sandbox" : "/"}>`
  so all existing absolute route paths (`/batches`, `/redeem`, `admin/...`)
  work unchanged under the prefix.
- Persistent SANDBOX banner on EVERY page (login and redeem included) — a
  fixed bar rendered at the app root outside route content, unmistakable,
  plus `document.title = "RMS (SANDBOX)"` when `isSandbox`.

## Acceptance

- Same dist: `/` is prod, `/sandbox/batches` is the sandbox batch list,
  both fully working from one `npm run build`.
- A sandbox API call lands on `/sandbox/api/...` on the wire (network-level
  assertion in a test or manual verification note).
- Banner visible on login, redeem, and every app page in the sandbox; absent
  in prod; tab titles differ.

## Standing docs

`docs/manual.md` gains its sandbox mention only in ticket 06's sweep; here,
update only lines this change itself invalidates.

## Comments

### 2026-10-06 - implemented

- **The seam** (`web/src/sandbox.ts`): exports `isSandbox` (derived ONCE at
  module load from `window.location.pathname` starting with `/sandbox` — the
  page cannot move between environments after load, so load-time derivation
  is exact, not a snapshot) and `apiBase` (`""` prod, `"/sandbox"` sandbox).
  No `import.meta.env`, no second build — one dist serves both environments.
- **API clients prefixed at the single fetch site** (`web/src/api.ts`,
  `web/src/admin/api.ts`): `fetch(`${apiBase}${path}`)` in `api` and
  `adminApi`, plus `adminUpload`'s raw upload fetch (the second fetch site in
  that file — restore sends bytes, so it needs the prefix too). The ~30
  call-sites hardcoding `/api/...` strings are untouched; `api`/`apiJson`/
  `adminApi`/`adminJson`/`adminUpload` are the only way any component talks
  to the app's API, so the prefix is applied in exactly two files.
- **Sweep for seam escapes** (`href="/api`, `fetch("/api`, `fetch(`(
  exhaustive), `action=`, `window.open`, `EventSource`, `XMLHttpRequest`,
  `.src =`, `<img`, `<iframe`, `location.assign/replace`, `new URL(`): found
  TWO escapees, both now routed through the seam — the known backup download
  anchor (`href={`${apiBase}/api/admin/backup`}` in `AdminBackupPage.tsx`)
  and one the ticket didn't know about: `ReportsPage.tsx` `downloadCsv` does
  a raw `fetch` (it needs a blob, not JSON, so it can't use `api()`). Not
  escapes, verified: `dymoClient.ts` talks to the local DYMO desktop service
  on `localhost:41951` (not this app's API); `AdminApiConsolePage`'s
  `"/api/skus"` is a payload string the server-side proxy resolves against
  its own instance — correct as-is; `sourceLink.ts` parses user-supplied
  URLs. Nothing else in `web/src` bypasses the two clients.
- **Router** (`web/src/main.tsx`):
  `<BrowserRouter basename={isSandbox ? "/sandbox" : "/"}>` — every existing
  absolute route path (`/batches`, `/redeem`, `admin/...`) works unchanged
  under the prefix. `document.title = "RMS (SANDBOX)"` set at the app root
  before first render when `isSandbox`; prod keeps the static `<title>RMS`.
- **Guardrail banner** (`web/src/components/SandboxBanner.tsx`): fixed red
  bar "SANDBOX — training environment, not production data" rendered at the
  app root in `main.tsx`, OUTSIDE `Routes` — login and redeem included, no
  page can opt out; `return null` in prod. The bar is `position: fixed` at
  the top with `z-index: 100` (above the z-50 modal overlay), and sets
  `body.sandbox` (padding-top) so page content renders below it instead of
  under it. CSS appended to `styles.css` (additive only).
- **Verification (manual, no browser connected to this session)**:
  - `npm run build` (exit 0) → ONE dist; `GET /` and `GET /sandbox/batches`
    both 200 serving the SAME `assets/index-C98A_zWf.js`.
  - Wire-level assertion: the built bundle contains
    `window.location.pathname.startsWith(\`/sandbox\`)` feeding `apiBase`
    and the `basename` ternary; `GET /sandbox/api/auth/me` returns JSON
    `{"error":"authentication required"}` (the sandbox instance's auth
    route — NOT the SPA shell), while `GET /` returns the HTML shell.
  - Banner/title/basename are render-time code paths in the bundle; a
    connected-browser visual check of login/redeem pages is the one thing
    still worth an eyeball.
  - `npm test` 571/571 (31 files, exit 0); `npm run typecheck` exit 0.
- **Not touched** (another agent's in-flight work): `addPartRequest.*`,
  `DeviceParts.tsx`, `batchparts.test.ts` — `DeviceParts.tsx` needs no edit
  anyway: it already goes through `apiJson`, so the seam covers it.
- **For ticket 03**: the login flow (`LoginPage`, `RedeemPage`,
  `auth.tsx`) already routes through the seam, so sandbox login POSTs land
  on `/sandbox/api/...` correctly; what remains for 03 is the SERVER-side
  login-link prefix (`${origin}/sandbox/redeem?...` from the email plug)
  and seeding/reset. Note: the sandbox DB ships empty (no users), so the
  first sandbox login requires 03's admin-created trainee user.
- **For ticket 06**: `docs/manual.md` sandbox section still to come; no
  standing-doc lines were invalidated by this change (docs describe domain
  behavior, not client fetch wiring).
