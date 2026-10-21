# Spec: Sandbox environment at /sandbox

A second, fully-wired instance of the same app runs **in the same process** as
production, with its **own SQLite database** (`data/sandbox.sqlite`), exposed at
the **path prefix `/sandbox`**. Purpose: staff training and feature testing
against realistic data, with zero risk to production data.

**Hold**: by user request, implementation waits until the currently in-flight
agent's work lands — every ticket below is `ready-for-agent` and unclaimed.

## Decisions (settled by grilling, 2026-10-06)

1. **Instance model**: second instance, same process, second DB file. One
   restart kills both; one `npm start` / `npm run dev` runs both. No new
   ports, no new env keys, no second client build. Always-on — no gate, no
   mode flag. (A "mode switch" variant was rejected as a silent mode.)
2. **Routing**: the sandbox app mounts at `/sandbox` on the main listener
   (Express prefix-strips, so domain routes register unchanged). In dev the
   Vite proxy gains one entry: `/sandbox` → the same port 3000. No second
   port anywhere.
3. **Client**: ONE dist serves both environments. One small module derives
   `isSandbox` from `window.location.pathname`; the router uses
   `basename="/sandbox"`, the API callers prefix `/sandbox` before
   `/api/...`, and the sandbox server builds login links as
   `${origin}/sandbox/redeem?...`. No `base:` rebuild.
4. **Cookies**: cookie names become part of the app context (explicit seam).
   Sandbox uses `sandbox_session` / `sandbox_admin_session` — hard-derived,
   not configurable — so prod and sandbox sessions on the same host never
   collide.
5. **Data lifecycle**: first run is an empty migrated DB (no users). Reset is
   manual only, from the sandbox admin panel: pick any `.sqlite` from
   `data/backups/` (newest first, `sandbox-` snapshots included) OR upload a
   file — both paths run the same integrity + migration-history validation as
   prod Restore; the sandbox DB is auto-backed-up first; sandbox sessions die
   with the reset (stated on the page). No automatic reset, ever.
6. **Auth**: the real login flow and real role gates — training must exercise
   manager approvals. Users come from the prod copy at reset; the sandbox
   admin panel creates trainee-only users inside the sandbox DB.
7. **Email**: ~~hard-disabled in the sandbox — login links ALWAYS go through
   the console-logging plug, never Resend. Not a setting.~~ **REVERSED
   2026-10-06 by user request**: the sandbox now runs the SAME email
   selection as production (`createEmailPlugFromEnv`) — Resend when
   `RESEND_KEY` is set, console logging otherwise. Training exercises the
   real email path; handing links over the console is not smart. A sandbox
   link still differs from a prod link by its `/sandbox` prefix, so it can
   never open the wrong environment.
8. **Admin panel** (`/sandbox/admin`, same `ADMIN_KEY`): Backup saves the
   sandbox DB as `sandbox-YYYYMMDD-HHMMSS.sqlite` in `data/backups/`; Clear /
   SQL console / API console operate on the sandbox DB only; Environment
   shows the shared `.env` plus the sandbox's resolved paths read-only;
   Restart restarts the whole process (both environments) and the page says
   so, still gated by `ALLOW_RESTART`.
9. **Left alone deliberately**: the audit scheduler runs untouched on the
   sandbox DB (real cadence, real windows); Dymo printing works from the
   sandbox (a printed label is a real duplicate sticker — accepted,
   self-inflicted); every domain registers in both instances automatically.
10. **Guardrail**: persistent `SANDBOX` banner on every page (login and
    redeem included) and tab title `RMS (SANDBOX)`, client-derived — a
    trainee can never mistake the two environments.

## Non-goals

- No sandbox branching inside domain logic anywhere (AGENTS.md review
  standard): the sandbox differs only at the seams — context (db, cookie
  names, mount prefix, email plug), never inside a domain rule.
- No subdomain, no second port, no second build, no auto-refresh or
  scheduled reset, no prod-admin action that touches the
  sandbox DB (each panel governs only its own DB).

## Tickets

See `issues/01` … `issues/06`. 01 is the foundation; 02–05 hang off it; 06 is
the final tests-and-standing-docs sweep.
