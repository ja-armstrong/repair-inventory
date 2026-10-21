# RMS

RMS (the shop's repair management system) tracks devices on batches, serialized
parts, purchase orders, and stock counts.

A single-site repair shop inventory: **Batches** of device repairs, serialized
parts with system-assigned **Serials**, **Purchase Orders**, **RMA Orders**,
**Return Orders**, **Buyback Orders**, and **Audits**. Built for a small team (≤3 users) at ~350
repairs/month: a tech
records devices on a batch, reserves parts against them, a manager approves the
parts cost, and the shop counts its stock on a schedule. All the domain
vocabulary — Batch, Serialized Part, Need to Order, Intake Source, and the rest
— is defined in [CONTEXT.md](CONTEXT.md).

This README is written for the person who keeps the shop's copy of the program
running, not only for developers.

## What you need

- [Node.js](https://nodejs.org) version 24 or newer (`node --version` to check).
- The project folder, with `node_modules` installed (next section).

## Install

In the project folder:

```
npm install
```

Do this once after downloading the project, and again whenever the project's
dependency list has changed.

## Configure

Settings live in a file named `.env` in the project folder (copy the included
`.env.example` to `.env`, or create it with any text editor, if it does not
exist). The keys the program reads:

| Key | What it does |
| --- | --- |
| `ADMIN_KEY` | The password for the admin panel at `/admin` (see below). Leave unset and the entire admin panel is disabled — every admin page answers 404. **This is also how the first user is created**: with a fresh (or wiped) database there are no users to log in as; set `ADMIN_KEY`, open `/admin`, and use **Users & roles** to create your users and send each one their login link. |
| `ALLOWED_EMAIL_DOMAINS` | The email domains accounts may belong to, comma-separated, e.g. `@acme.co,@acme.com`. Checked whenever a user is created or a login link is requested. The server refuses to start without a valid value. |
| `APP_ORIGIN` | Fallback web address used when building login links when the browser did not send its Origin (tests, command-line tools). Normally unnecessary: links follow the browser's own Origin, so a LAN demo at `http://192.168.1.100` stays on that address. For `npm run dev` on this PC, `APP_ORIGIN=http://localhost` is a sensible fallback. |
| `DB_PATH` | Where the database file lives. Default: `data/repair-inventory.sqlite`. |
| `PORT` | The port the API server listens on. Default: 3000. |
| `RESEND_KEY` | An API key for Resend (resend.com). When set, login links are sent as real email. Leave unset and links are printed only in the server console. |
| `RESEND_FROM` | The sender address for login-link emails, e.g. `RMS <no-reply@example.com>`. Default: `RMS <onboarding@resend.com>`, Resend's shared test sender, which delivers only to this Resend account's own email address. Once a domain is verified in Resend (Domain settings → add the domain, add the DNS records it shows), set this to an address on that domain and links reach anyone. A rejected send fails loudly on the server and the console log still shows every link. |
| `ALLOW_RESTART` | Set to `true` only if the server runs under a supervisor (an NSSM service, a scheduled task with restart, pm2) that starts it again after it exits. It unlocks the **Restart** button in the admin panel. Leave unset in normal `npm start` runs: without a supervisor, an exit stops the server until a person starts it again. |

**Editing `.env` from the admin panel:** the keys `APP_ORIGIN`,
`RESEND_KEY`, `RESEND_FROM`, and `ADMIN_KEY` can be changed in the admin panel's **Environment**
page (`/admin/env`) — secrets are shown masked and are never sent to the browser in full. Any
change there takes effect only after the server is restarted; the page says so and offers a
restart button where the server's supervision allows it. `ALLOWED_EMAIL_DOMAINS`, `DB_PATH`,
and `PORT` are shown read-only on that page: edit them directly in the `.env` file.

## Run

### Day-to-day (development)

```
npm run dev
```

Starts both halves in one terminal: the API server (port 3000, restarts when
server code changes) and the web client (port 80). Both listen on every
network interface. On this PC use http://localhost; on another computer on
the same LAN use http://rmshost.local (Windows answers mDNS queries for the
machine name) or http://&lt;this-pc-ipv4&gt; (Vite prints that Network URL
when it starts). No port suffix is needed. Windows Firewall must allow Node
on TCP 80 or the other computer cannot connect.

### Production

```
npm run build
npm start
```

`npm run build` builds the web client into `web/dist`; `npm start` then serves
the built client and the API from one address, http://localhost:3000. If
`web/dist` does not exist, `npm start` runs the API alone.

### The sandbox environment

Alongside the main app, the server always runs a second, fully separate
instance at `/sandbox` — same process, same port, no second server to start.
It keeps its own database (`data/sandbox.sqlite`) and its own logins, so
nothing written there ever touches production data. The startup console line
names both database paths. Open `http://localhost/sandbox` (or
`http://<host>:3000/sandbox`) in the browser for the full app — every page
carries a red SANDBOX banner and the tab is titled RMS (SANDBOX) — and
`/sandbox/admin` is the sandbox's own admin panel, opened with the same
`ADMIN_KEY`. Its backup button saves `sandbox-YYYYMMDD-HHMMSS.sqlite` into the
same `data/backups/` folder, and its Restart button stops the WHOLE server
process: sandbox and production go down and come back together.

### Logging in

There are no passwords. On the login page, request a link for a registered
email address. If `RESEND_KEY` is set, the link is emailed (see Environment
above); if not, it is printed in the API server's console. Links expire after
15 minutes and work once. The sandbox logs in exactly the same way — it sends
through the same email setup, and its links carry the `/sandbox` prefix so
they open the sandbox, not the main app.

## Test

```
npm test
```

Runs the automated test suite (vitest): each test starts from a throwaway
database, so testing never touches your real data. `npm run typecheck`
type-checks both server and web client.

## Backup — the disaster-recovery path

Production data lives in **one file** (default `data/repair-inventory.sqlite`).
Backing up that file IS the disaster recovery; make it a habit. The sandbox
environment keeps its own separate file (`data/sandbox.sqlite`): it holds no
production data and never needs to be backed up — backups made from the
sandbox panel are its own safety nets, saved as
`sandbox-YYYYMMDD-HHMMSS.sqlite` in the same `data/backups/` folder (the
`sandbox-` prefix is how you tell the two databases' snapshots apart).

1. Set `ADMIN_KEY` in `.env` and restart the server.
2. Open the admin panel: `http://localhost/admin` (dev) or
   `http://<host>:3000/admin` (production). It is not linked anywhere in the
   main app — type the address. It has its own key login, separate from the
   app's user accounts, and is completely absent when `ADMIN_KEY` is unset.
3. Click **Backup**. One click saves a consistent copy to `data/backups/`
   (`repair-inventory-YYYYMMDD-HHMMSS.sqlite`) and downloads it.
4. Copy the `data/backups/` folder somewhere OFF this computer regularly
   (a USB stick, a network share, cloud storage). A backup on the same disk
   does not survive the disk.

## Restore

In the admin panel, upload a `.sqlite` backup file. It is validated first
(integrity check + migration history); the current database is backed up
automatically; the file swap happens the next time the server is restarted (the
page says so). Writes made between staging the restore and the restart are
discarded — restart promptly.

## Reset the sandbox (the trainer's flow)

The sandbox starts empty. To train or test against realistic data, reset it
from a backup. Resetting is manual only — there is no schedule and nothing
resets automatically.

1. In the production admin panel, click **Backup** — or use any `.sqlite`
   file already in `data/backups/` (older `sandbox-` snapshots of the sandbox
   itself are legitimate reset sources too).
2. Open the sandbox panel, `/sandbox/admin`, with the same `ADMIN_KEY`, and
   open its **Reset** page.
3. Pick a file from the list (newest first; `sandbox-` snapshots are labeled
   so you never mistake one for a production copy) or upload a file. The file
   is validated first (integrity check + migration history); a bad or missing
   file is refused loudly and the sandbox keeps running untouched.
4. When a file passes, the sandbox's CURRENT database is backed up
   automatically first — the response shows its filename, and that backup is
   your undo path. The swap is then staged.
5. The swap takes effect at the NEXT server restart. Restart, and the sandbox
   serves the data from the file you chose.

The Reset page states the consequences plainly, and the server repeats them:
resetting logs out everyone in the sandbox (sessions live in the database),
and every trainee-created user vanishes. Production data is never touched —
the reset swaps the sandbox's own file, from the sandbox's own staging slot.

## Other admin panel tools

- **Users & roles** — create users, set roles (tech / manager / admin),
  deactivate or reactivate accounts, and send login links. This is how a
  fresh or wiped database gets its first user, and how anyone gets back in
  when email delivery is not configured.
- **Environment** — edit the server's `.env` settings (email sending, admin key)
  without connecting to the server. Secrets are masked, and every change clearly states it takes
  effect at the next restart. The same page has a **Restart** button: under `npm run dev` the
  server restarts itself; in production it is refused unless `ALLOW_RESTART=true` is set to
  confirm a supervisor (service/scheduled task/pm2) will start the server again. A restart ends
  all admin sessions — the key must be re-entered; main-app user sessions survive.
- **Clear the database** — requires typing `ERASE ALL DATA`; a backup is always
  taken first (its filename is shown), then everything is wiped and rebuilt
  empty — users included. Recovery is this same panel: create your users in
  **Users & roles** and send each one their login link.
- **SQL console** — SELECT-only by default. Writes require enabling write mode
  per session by typing `ALLOW WRITES`, and every write is backed up first.
  Every executed statement is logged in the server console.
- **API console** — run real API calls against this server from the panel. Each
  call runs as the first active manager or admin through the app's normal
  routes (full validation and timeline events, nothing bypassed); only `/api/...`
  paths and `/health` are allowed, and responses — including errors — are shown verbatim.
- **System info** — row counts per table, applied migrations, uptime, and the
  database file's path and size.

The sandbox panel at `/sandbox/admin` has the same tools, all aimed at the
SANDBOX database: Backup saves `sandbox-YYYYMMDD-HHMMSS.sqlite` (the prod
panel's `repair-inventory-…` name is unchanged), Clear wipes only the sandbox,
and the Restart button restarts the WHOLE server process — sandbox and
production stop together and come back together, still gated by `ALLOW_RESTART`.
It also has the **Reset** page the production panel does not have (the
section above); the production panel's Restore card is absent there on
purpose — resetting from a backup replaces it, staged into the sandbox's own
slot.

## Where to read more

- [CONTEXT.md](CONTEXT.md) — the vocabulary of the shop's world (what a Batch,
  a Need to Order, an Intake Source *is*). Read this first.
- [docs/logic-map.md](docs/logic-map.md) — every route, every state machine,
  and the map of which part of the program touches which other part's data.
- [docs/data-model.md](docs/data-model.md) — every table, column, and rule the
  data obeys.
- [docs/adr/0001-sqlite-prototype-postgres-migration.md](docs/adr/0001-sqlite-prototype-postgres-migration.md)
  — why the data lives in a single SQLite file and how a move to Postgres would
  work.
- [docs/manual.md](docs/manual.md) — the simple-English user manual: how to use
  the app, flow by flow, for a non-technical reader.
- `docs/agents/` — conventions for AI agents working on this repository.

## Layout (for developers)

- `server/` — Node + Express 5 API (TypeScript, strict)
  - `server/domains/<name>/` — one folder per domain, exporting a registration
    function; added to the explicit list in `server/bootstrap.ts` (the admin
    domain sits first by design — see the list's comment)
  - `server/db/migrations/` — numbered additive SQL files (`0001-<slug>.sql`),
    applied in order by `server/db/migrate.ts`; never renumber
  - `server/tests/harness.ts` — **the single test seam**: fresh temp SQLite
    database + fake clock + supertest, no database mocking
- `web/` — React + Vite client; one page component per nav area under
  `web/src/pages/`, the admin panel under `web/src/admin/`

## Conventions for later tickets

- All tests go through `createTestHarness()` in `server/tests/harness.ts` —
  copy the pattern in `server/tests/health.test.ts`.
- Never read wall time in server code: use the injected `Clock`
  (`server/clock.ts`); tests advance `harness.clock`.
- New schema = one new numbered migration file; nothing else.
- New domain = one new `server/domains/<name>/` folder + one line in
  `server/bootstrap.ts`. Future endpoints live under `/api` and require a
  session; the only unauthenticated routes are `GET /health` and the login flow
  itself (`POST /api/auth/request-link`, `POST /api/auth/redeem`).
- Documentation is part of the change: if a commit invalidates a line in this
  README, `docs/logic-map.md`, or `docs/data-model.md`, that line is updated in
  the same commit (see AGENTS.md).
