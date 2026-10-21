# 01: Scaffold the app and the single test seam

**What to build:** The walking skeleton of the whole system: one TypeScript package containing the Node API server and the React/Vite web client, with the conventions every later ticket builds on — domain-module route registration, numbered additive migrations run by a tiny runner, and the one test seam (in-process HTTP requests against a throwaway per-test SQLite file). A logged-in-user-free health endpoint and an empty app shell (nav placeholder for batches, inventory, orders, audits, search, reports) prove the whole path: schema → API → client build. Install ALL project dependencies now (server, test, client, barcode, CSV) so later tickets never edit package.json.

**Blocked by:** None (can start immediately).

**Status:** ready-for-human

- [ ] A single root package with the server and web client as sibling source trees; `npm run dev` serves both, `npm run build` produces a production build the server can serve
- [ ] A migration runner applies numbered SQL migration files in order and records applied ones; a first migration creates the schema-machinery table
- [ ] Domain modules self-register routes through a bootstrap that scans a domains directory; a health endpoint proves the path
- [ ] The test harness: in-process HTTP tests (vitest) run against a per-test throwaway SQLite database with an injectable clock; one example test asserts the health endpoint
- [ ] `npm test` and `npm run typecheck` are green from a clean checkout; dependencies for the whole project (web framework, router, test runner, HTTP test lib, sqlite driver, barcode and CSV generation, validation) are installed
- [ ] The app shell renders with navigation for the major areas (Batches, Inventory, Orders, RMA, Audits, Search, Reports) and a login placeholder

## Comments

**Built** (commit `1597535`): single root package, `server/` (Express 5 + TypeScript strict) and `web/` (React 19 + Vite 8 + react-router) as sibling trees.

- Test seam: `server/tests/harness.ts` exports `createTestHarness()` — fresh temp-directory SQLite file, migrations applied, `FakeClock` injected, supertest agent bound to the in-process app, `close()` for `afterEach`. `server/tests/health.test.ts` is the example to copy: response assertions plus database-visible outcomes plus a clock-stamp assertion. No database mocking anywhere.
- Migrations: `server/db/migrations/0001-migrations-table.sql` (the `migrations` table; the runner also bootstraps it in code so it can record — the file is idempotent and gives the numbering a first entry). Runner `server/db/migrate.ts` validates `NNNN-slug.sql` naming, contiguous numbering from 0001, and no recorded-but-missing migrations; each migration applies + records in one transaction, `applied_at` stamped through the injected clock.
- Domains: `server/domains/health/index.ts` exports `healthDomain` (GET /health, intentionally unauthenticated, returns `{ status, migrations }`). Explicit registry in `server/bootstrap.ts` — later tickets append one line. Convention going forward: all future endpoints under `/api`, all authenticated.
- Clock: `server/clock.ts` — server code reads time only through `Clock`; tests use `harness.clock` (`set`/`advance`).
- Web shell: `web/src/components/AppLayout.tsx` nav for Batches, Inventory, Orders, RMA, Audits, Search, Reports + Log in; one placeholder page file per area under `web/src/pages/` for later tickets to replace. Vite dev proxies `/health` and `/api` to the API.
- Commands that work (verified): `npm run dev` (API on :3000 + Vite on :5173, proxy confirmed), `npm run build && npm start` (static client served from the server; `/health`, `/`, `/batches` all 200), `npm test` (3 passing), `npm run typecheck` (clean). `README.md` documents all of this.

**Deviations from the ticket:**
- Added `tsx` (devDependency) beyond the pinned dependency list — something must run TypeScript at dev/runtime, and `npm run build` only compiles the client. All pinned dependencies were installed as specified; later tickets never need to touch package.json.
- Ticket said the bootstrap "scans a domains directory"; the pinned decisions explicitly prefer an explicit list over filesystem magic, so `server/bootstrap.ts` uses the explicit list (this note records that the ticket text lost to the pinned decision).
- Production runs the server from source via tsx (`npm start`); only the client is compiled, per the spec's "production build serves the compiled client from the server". No `NODE_ENV` juggling: the server serves `web/dist` whenever it exists.

**Surprises for later tickets:**
- Stack resolved newer than the ticket text may assume: TypeScript 7, Vite 8, vitest 5, Express 5.2, React 19, better-sqlite3 13 (prebuilt binary loaded fine on Windows/Node 24).
- vitest does not typecheck — a bare `readdirSync` bug passed tests and was only caught by `npm run typecheck`. Keep both in the loop.
- supertest 7's types: use `ReturnType<typeof supertest>` for the agent type (the old `SuperTest<Test>` annotation no longer matches what `supertest(app)` returns).
- npm's allow-scripts warning about better-sqlite3/esbuild install scripts was a false alarm — both binaries loaded and ran fine; no action needed.
