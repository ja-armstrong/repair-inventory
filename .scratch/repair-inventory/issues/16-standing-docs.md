# 16: Standing docs — logic map, data model, README

**What to build:** The standing documents AGENTS.md requires, written against the finished codebase, for the maintainer and the inheriting dev team:

- `docs/logic-map.md` — each domain: its routes, its state machines (batch lifecycle, device repair statuses, part statuses, PO / RMA / audit lifecycles), and a cross-domain reads/writes matrix (who touches whose tables, through what contract) — the map that makes unexpected behavior *between* seams visible.
- `docs/data-model.md` — every table, column, relationship, and invariant (unique partial indexes, CHECK constraints, money as integer cents), plus the migration list in order.
- `README.md` completed — install, run, test, **backup** (the copy-the-file path ADR-0001 makes the disaster-recovery story), and the bootstrap-manager provisioning path, for a non-developer maintainer.

Use CONTEXT.md vocabulary throughout. Accuracy over prose: every route and table in the code appears in the docs; anything in the docs not in the code is a defect.

**Blocked by:** 13, 15 (document a feature-complete, corrected codebase).

**Status:** ready-for-human

- [x] Logic map and data model are accurate against the code — spot-checkable: every route and table appears, nothing extra
- [x] README covers install, run, test, backup, and bootstrap-manager provisioning
- [x] The documents state the cross-domain contracts explicitly enough that a new maintainer can change one domain without spelunking the others

## Comments

- Wrote `docs/logic-map.md` (~430 lines): the domain registry in bootstrap order, one section per domain (purpose, full route table with method/path/who/behavior, state machines as plain arrow lists), the cross-domain reads/writes matrix (every claim derived from the code — module imports vs direct SQL named per cell), and shared infrastructure (clock, migrations runner, events/timeline seam, parts status module, serial allocator, email plug, admin gate, the session-gated /api router, app settings, money).
- Wrote `docs/data-model.md` (~430 lines): migration list as table of contents, then every table in migration order with columns/types/CHECKs/indexes/FKs, plus the "invariants the schema alone does not carry" section (reservation only through batches, computed Parts Cost, single-writer status columns, intake-source seam rule, danger rules, etc.).
- Rewrote `README.md` for a non-developer maintainer: what the app is, install, the five `.env` keys and what each does, run (dev + production), login flow, test, **backup as the disaster-recovery path** (admin button + `data/backups/` + copy off-computer), restore, admin panel tools, and pointers to CONTEXT.md / docs/.
- Doc-vs-code mismatches found and fixed IN THE DOCUMENTS ONLY:
  1. README claimed "each nav area has a placeholder page under `web/src/pages/`" — stale: every page is implemented; `PlaceholderPage.tsx` still exists but is imported by nothing.
  2. README claimed "`GET /health` is the only unauthenticated route" — the login flow (`POST /api/auth/request-link`, `POST /api/auth/redeem`) is unauthenticated too. Reworded to name the exceptions.
  3. README had no explicit install step or `.env` key table; added both.
- Real code bugs found: **none**. One observation, not acted on: `web/src/pages/PlaceholderPage.tsx` is dead code (defined, never imported) — harmless, left alone since this is a docs ticket.
- Spot-checks performed: 5 routes (batch approve, GET /api/purchase-orders/demand, GET /api/audits/status, POST /api/skus/:id/parts intake schema, DELETE /api/admin/session) and 5 tables (purchase_order_expected_serials CHECK, audit_parts composite PK, sessions.created_by_token, device_parts rebuilt CHECKs of 0012, batches approval columns) re-verified line-by-line against the source after writing.
- Note for the next agent: AGENTS.md lists `docs/manual.md` as a standing document, but no such file exists yet. The README points to it with an explicit "not yet written" note rather than a dead link; whoever owns the manual ticket should write it and update that line.
