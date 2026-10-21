# 02: Passwordless auth, users, and roles

**What to build:** The full login and user-management loop, end to end. A visitor requests a magic link by email; the email plug logs it (console + visible in dev UI); the link redeems within 15 minutes into a persistent session cookie; logout works. The bootstrap manager (from environment config) can create users by @acme.co/@acme.com email, change roles between manager and tech, and deactivate users. Every authenticated request knows the acting user. Unauthenticated requests are rejected; manager-only endpoints reject techs. Establish the timeline/events table here (actor, timestamp, action) since every later domain writes to it.

**Blocked by:** 01 (scaffold and test seam).

**Status:** ready-for-human

- [x] Requesting a login link for an allowlisted email produces a single-use token that expires after 15 minutes (tested with the injectable clock); links logged through the email plug interface are retrievable in tests
- [x] Redeeming a valid link establishes a persistent session; expired, used, and unknown tokens are rejected; logout clears it
- [x] The bootstrap manager is provisioned from environment configuration on first run
- [x] Managers create users (allowlisted domains only), change roles, and deactivate users; deactivated users cannot log in; techs are refused on user-management endpoints
- [x] All non-health endpoints require a session; the acting user is resolvable by downstream handlers
- [x] Login, link-redemption, logout, and user management work in the web client; manager-only UI is hidden from techs
- [x] API tests at the seam cover the happy path and each rejection (expiry, reuse, wrong domain, wrong role)

## Comments

**Built** (commit `b47179b`): the whole loop — magic links, persistent sessions, user management, the timeline events table, and the web client screens.

- **Migration `0002-users-sessions-events.sql`**: `users` (email unique, role manager/tech, active 0/1), `login_tokens` (token, expires_at, used_at — single-use), `sessions` (no server-side expiry), and the append-only `events` table (entity_type, entity_id, actor_id, at, action, payload JSON) with an entity index. ISO-8601 UTC text timestamps, portable SQL only per ADR-0001.
- **Auth domain** (`server/domains/auth/`):
  - `index.ts` — mounts the shared `/api` router, provisioned the bootstrap manager from `BOOTSTRAP_MANAGER_EMAIL` at registration (idempotent; throws on a non-allowlisted value; warns when unset), and owns the public login routes (`POST /api/auth/request-link`, `POST /api/auth/redeem`) plus `GET /api/auth/me`, `POST /api/auth/logout`.
  - `session.ts` — resolves the acting user onto `req.currentUser` (Express Request declaration merging) from the session cookie (hand-parsed; no cookie-parser dependency), sets the httpOnly SameSite=Lax cookie with a 400-day maxAge (the browser cap; the server-side session never expires), and exports `requireSession` / `requireManager` middlewares.
  - `email-plug.ts` — the `EmailPlug` interface (`sendLoginLink(to, url, expiresAt)`) plus the only implementation, `createLoggingEmailPlug` (console log + a `sent` list tests retrieve through the harness). SMTP later = new implementation, zero call-site changes.
  - `events.ts` — `recordEvent(db, clock, {entityType, entityId, actorId, action, payload})`, the one timeline write path every later domain imports. Conventions documented in the file: `action` = `<entity>.<past-tense-verb>`, old→new values as `{from, to}` in the payload, `actorId: null` for system actions, notes are `note.added` events with text in the payload.
  - `users.ts` — manager-only `GET/POST /api/users`, `PATCH /api/users/:id/role`, `POST /api/users/:id/deactivate`. Deactivation deletes the user's sessions immediately and blocks both new link requests and redemption of outstanding links (403). Guards refuse demoting/deactivating the **last active manager** (409) so the system can never strand itself without a user manager.
- **The pattern later domains copy** (documented in `server/domains/auth/index.ts`): register after `auth` in `server/bootstrap.ts`, then `const api = getApiRouter(app);` — the router is already session-gated, so `req.currentUser!` is the acting user and `requireManager` composes onto manager-only routes. Bootstrap touch = one registry line (+ its import).
- **Harness** (`server/tests/harness.ts`): now pins `BOOTSTRAP_MANAGER_EMAIL` per app (default `manager@acme.co`, `null` to test unset), exposes `emails` (the logging plug), and adds `loginAs(email)` (real request-link → retrieve from plug → redeem flow, cookie-carrying agent) and `createUserAs(email, role)` for later tickets' setup. Existing tests untouched and green.
- **Web client**: `LoginPage` (request-link form + "also printed in the server console" dev hint), `RedeemPage` (`/redeem?token=...`), logout in the header, manager-only `UsersPage` (create / role toggle / deactivate) with the nav item hidden for techs, `AuthProvider` + `RequireAuth` route gating in `main.tsx`, and a thin fetch client (`web/src/api.ts`). `/login` and `/redeem` are the only public client routes.
- **Tests** (`server/tests/auth.test.ts`, `users.test.ts`, 32 new + 3 existing, 35 passing): happy path + every rejection — wrong domain, malformed email, unknown email, expiry (exactly 15 min via `clock.advance`, and still-valid at 14:59), reuse, unknown token, unauthenticated `/api/*`, logout clearing the session, tech-vs-manager on each users endpoint, last-manager guard, deactivated login refusal (including an outstanding link), and timeline events (actor, clock-stamped `at`, `user.created` / `user.role_changed` `{from,to}` / `user.deactivated`).

**Commands verified green:** `npm test` (35 passing), `npm run typecheck` (server + web), `npm run build`. Also smoke-tested the real server (`tsx server/index.ts` with `BOOTSTRAP_MANAGER_EMAIL`): provisioning, `/health`, 401 on `/api/auth/me`, and a logged link all work.

**Deviations from the ticket text:**
- The guardrail said "the single accepted line in bootstrap.ts" — that's the registry entry; its `import` line is the mechanical second line. No other shared server file touched (`domain.ts`, `app.ts`, `index.ts`, `package.json` all unchanged).
- "Email plug logs it (console + visible in dev UI)": the dev-UI surface is a note on the login page pointing at the server console — no endpoint exposes delivered links (that would let anyone with the URL harvest login links).
- Added the last-active-manager guard (409 on demote/deactivate) — not in the ticket, but without it a manager can lock the whole system out of user management with one click.
- Login links point at `${APP_ORIGIN:-http://localhost:3000}/redeem?token=...`; set `APP_ORIGIN=http://localhost:5173` in dev if you want the logged link to open straight into the Vite dev server.
- GET /api/users is manager-only too (matches the hidden UI and the "techs refused on user-management endpoints" line; any-session listing was the alternative).

**Surprises for later tickets:**
- Express 5 types `req.params.id` as `string | string[]` — parse helpers must widen.
- No `cookie-parser` in the pinned dependencies, so the session cookie is parsed by hand in `session.ts` (`readSessionCookie`) — keep using that, not `req.cookies`.
- vitest parallel workers: supertest `Test` objects created but not awaited race the ephemeral server (ECONNREFUSED) — create requests lazily inside the loop/await.
- `server/app.ts` mounts `express.json()` globally, so `/api` bodies parse already; `@types/express` 5 accepts `async` route handlers (rejections forward to the central error handler).
- Zod 4: use `z.email()` (top-level format), not the deprecated `z.string().email()`.
