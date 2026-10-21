# 22: Admin panel — .env editor, restart, and API console

**What to build:** Three owner tools in the admin surface, completing "the panel runs the server, not just the data":

## A. .env editor
- New module (`server/domains/admin/envfile.ts`): read/parse/render the `.env` file preserving comments, blank lines, and unknown keys; atomic writes (temp file + rename); the file path is `<project root>/.env` with an explicit `RMS_ENV_FILE` override as the documented test seam.
- Catalog (single source of truth): **editable** — `BOOTSTRAP_MANAGER_EMAIL`, `APP_ORIGIN`, `RESEND_KEY` (secret), `RESEND_FROM`, `ADMIN_KEY` (secret); **read-only display** — `DB_PATH`, `PORT`, each with its reason ("a wrong value here makes the server start a new, empty database — edit the file directly").
- `GET /api/admin/env`: for each entry — key, description, editable, secret, masked value for secrets (never the full value — `(set ····abcd)` or `(not set)`), and a **pending-restart** flag (file value differs from the live `process.env` value; compared internally, sent as a boolean only).
- `PUT /api/admin/env` `{key, value}`: refuses non-editable keys loudly with the reason; a secret submitted empty = no change; `BOOTSTRAP_MANAGER_EMAIL` must be allowlisted (`@acme.co`/`@acme.com`) — a bad value would crash the next startup at provisioning time, so it is rejected now; other empties are legal (ADMIN_KEY empty disables the panel after restart — documented). Atomic write; console-log the changed KEY (never a secret's value).
- **Restart honesty**: every edit response and the UI state plainly that changes take effect when the server restarts.

## B. Restart button
- `POST /api/admin/restart` `{confirmation: "RESTART"}`: responds 200 first, then `process.exit(0)` on a short delay.
- **Supervision gate (explicit, not heuristic):** allowed when `npm_lifecycle_event === "dev"` (the dev script runs `tsx watch`, which restarts on child exit). In production (`npm start` has no watch) it is refused with a 409 explaining exactly this — unless `ALLOW_RESTART=true` is set, acknowledging the server runs under a supervisor (NSSM service, scheduled task with restart, pm2). UI shows which state applies and why.
- Warning surfaced in the UI: a restart ends all admin sessions (in-memory) — the key must be re-entered; main-app sessions live in the database and survive.

## C. API console
- `POST /api/admin/api-console` `{method, path, body?}`: dispatches the request against this same app (self-fetch to `127.0.0.1:<port>`), so the owner can drive the real API from the panel.
- **Runs as the bootstrap manager**: the console creates a real session for the configured manager (via the existing session seam) and attaches it to the dispatched request — `/api/*` endpoints see a legitimate manager, and every mutation flows through the app's own validation, events, and required notes (no invariants bypassed, unlike raw SQL).
- Guards: path must be same-app (`/api/...` or `/health` — refuse anything else, loudly); method limited to GET/POST/PATCH/PUT/DELETE; body must parse as JSON when present; the response's status, headers of interest, and body are returned verbatim (truncate huge bodies client-side). Non-2xx responses are shown, not hidden.
- UI (mirror the SQL console's layout): method + path + body, run button, response pane with status coloring, and a short in-page history of recent calls.

**Blocked by:** none.

**Status:** ready-for-human

- [x] .env editor: catalog, masked GET, guarded PUT, atomic write preserving unknown keys/comments, pending-restart flags (tests: masking — the ADMIN_KEY value never appears in a response; comment/unknown-key preservation; allowlist rejection; read-only refusal; empty-secret no-op)
- [x] Restart: confirmation phrase, respond-then-exit, supervision gate with the dev/ALLOW_RESTART logic (tests: refused in production mode without the flag; the gate's state is visible to the UI)
- [x] API console: self-dispatch runs as the bootstrap manager (test: a manager-only endpoint succeeds through the console and the resulting event carries the manager as actor); same-app path guard (test); JSON-body validation (test)
- [x] Admin UI: Environment page (per-row save, pending-restart markers, read-only rows with reasons), restart button with its state messaging, API console page
- [x] Docs updated in the same commit (README .env table, manual admin sections, logic-map admin routes + new module)
- [x] Full suite, typecheck, build green

## Comments

- `server/domains/admin/envfile.ts` is the file seam: line-preserving parse/render (comments, blank lines, unknown keys survive every edit byte-for-byte), atomic write (unique temp file in the same dir + fsync + rename). `RMS_ENV_FILE` overrides the path and is read at CALL time, not import time, so tests pin it per request like the harness pins BOOTSTRAP_MANAGER_EMAIL.
- The parser was verified empirically against Node 24's `process.loadEnvFile`/`parseEnv`: unquoted values keep spaces and `$` literally, `#` starts a comment, single quotes are fully literal (even backslashes), double quotes decode `\n`-style escapes and cannot contain a raw `"`. `renderAssignment` picks the first safe form (unquoted → single-quoted → double-quoted) and THROWS on values it cannot represent (newline, or `'` together with `"`/`\`) instead of mangling them — a mangled ADMIN_KEY would lock the owner out after restart.
- Secrets masking: `(set ····abcd)` shows the last 4 chars only when the value is longer than 8 chars; shorter secrets show `(set ····)` — revealing the tail of a short secret would reveal most of it. Pending-restart is a boolean computed by comparing the file value with live `process.env` internally; the two values are never both sent.
- Empty-secret PUT is a no-op by design, so ADMIN_KEY cannot be cleared through the editor (that would silently disable the panel); the catalog description documents that disabling it requires editing the file directly.
- Restart: `GET /api/admin/restart` exposes the gate state for the UI (mode dev/supervised/refused + explanation, read at request time). `POST` requires the exact `RESTART` phrase, answers 409 with the supervisor explanation when the gate refuses, otherwise responds 200 first and `process.exit(0)` after 300ms (`RESTART_EXIT_DELAY_MS`). The exit path was tested with `process.exit` spied (mocked), so no test ever kills the runner.
- API console: creates a REAL session row for `BOOTSTRAP_MANAGER_EMAIL` via `createSession` (the existing auth seam), attaches it as the main `session` cookie on a self-fetch to `127.0.0.1:<PORT>` (PORT read at request time; tests run a real listener on an ephemeral port and pin the env), and DELETES the session after the dispatch — one call = one ephemeral session. `redirect: "manual"` so redirects are shown, not silently followed. Guards: `/api/...` or `/health` only, no `..`, method enum, body must be a JSON object. Non-2xx (JSON and text bodies) pass through verbatim.
- No schema migration was needed (sessions table already exists) — 0014 remains the latest.
- Test count: 345 (322 before + 23 new in `server/tests/admin-env-restart-console.test.ts`).
