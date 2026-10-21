# 15: Small correctness fixes from review

**What to build:** The small, unambiguous review findings, each with a test:

- Delete the demand existence-guessing: `purchaseorders/demand.ts` probes `sqlite_master` and degrades to empty/skips validation when the table is "somehow absent" — the migration runner is the contract, so the guards come out and a broken database fails loudly (architecture C, review S1).
- Portable-SQL sweep: `COLLATE NOCASE` (parts list, models list) and `INSERT OR IGNORE` replaced with portable equivalents — ADR-0001's migration path is the pitch (architecture E).
- `getSettingInt` returns NaN/0 silently on unparsable or unknown values while its comment claims a default fallback — throw on unparsable/non-positive, default only for a missing row (review S3).
- `getBatchNumber` returns `?? 0`, fabricating batch #0 into immutable event payloads — throw or take the number from the already-loaded row (review S4).
- Route shadowing: the one-segment `/api/parts/:serial` route's order-dependence made explicit or removed (review minor).
- Model-name lookup is case-sensitive while parts/serials are case-insensitive — match the convention (review minor).

**Blocked by:** 14 (fix the consolidated modules, not the pre-consolidation copies).

**Status:** ready-for-human

- [x] Demand guards deleted; a missing-table failure surfaces as a loud 500 (test)
- [x] No SQLite-only SQL constructs remain (`sqlite_master`, `COLLATE NOCASE`, `INSERT OR IGNORE`); grep clean
- [x] `getSettingInt` throws on unparsable/non-positive values (test); `getBatchNumber` cannot fabricate 0 (test — S4, already fixed by ticket 14; verified, see Comments)
- [x] Route-order dependency documented or removed; model lookup case-insensitive (test)
- [x] Full suite, typecheck, and build green

## Comments

- **S1 / arch-C (demand existence-guessing):** `demandTableExists` and `hasDemandTable` are deleted. `demandExists` is a plain query; `listOutstandingDemand` no longer degrades to `[]`. The PO create route validates demand ids unconditionally. Tests (written first, both failed before the fix): dropping `demand_records` makes `GET /api/purchase-orders/demand` return 500, and a PO create with a `demandId` returns 500 with **no PO row created** (previously it silently created one with a dangling link). The old migration-0006 comment "purchase orders must apply even before 0005 has run" described a scenario the migration runner's strict ordering already makes impossible — that ordering is the contract.
- **Arch-E (portable SQL):** parts list `ORDER BY name COLLATE NOCASE, id` → `ORDER BY LOWER(name), id`; models list `ORDER BY m.name COLLATE NOCASE` → `ORDER BY LOWER(m.name), m.id` (id tiebreaker added so case variants order deterministically); `INSERT OR IGNORE` → `INSERT … ON CONFLICT (po_id, demand_id) DO NOTHING` against the existing `UNIQUE(po_id, demand_id)`. Behavior pins added: case-insensitive catalog ordering, case-insensitive model-list ordering, and "a demand id referenced by several lines of one PO links exactly once". `grep -ri "COLLATE NOCASE\|INSERT OR IGNORE\|sqlite_master" server/` is clean.
- **S3 (getSettingInt):** now throws on an unparsable, non-integer, or below-`min` value (min from `SETTING_DEFINITIONS`, so `label_*_sixteenths` enforce 8) and on an unknown key; the seeded default applies only to a missing row. Doc comment rewritten to state the actual contract. Tests: `price_expiry_days = 'soon'` and `= '0'` both turn `GET /api/skus` into a 500. Surprise worth recording: the unparsable case *already* failed loudly before the fix — by accident, because `serializeSku` hits `new Date(NaN).toISOString()` and throws. The fix makes loudness the function's contract instead of a side effect of one call site (the audit-scheduling path had no such accident: `addMonthsUTC` on NaN silently produced a NaN date).
- **S4 (getBatchNumber):** already fixed — verified `batchparts/queries.ts:66` now throws `"no batch with id … — refusing to fabricate a batch number for the timeline"` (ticket 14's work). Skipped; the ticket-14 change is covered by its own tests.
- **Route shadowing (minor):** documented as a contract, not left as lore. The dependency turned out to be *shape*, not order: the parts domain's `GET /:serial` matches one segment only, so batchparts' two-segment `/:serial/attachments` can never be shadowed regardless of mount order; what WOULD be shadowed is a future one-segment GET registered after `/:serial` in the parts router. Both registrations now carry comments stating this, and a pin test asserts both endpoints resolve in the standard app. A reversed-registration test was not added: the bootstrap list is the deliberate single source of route order, and reordering domains in a test would test Express's router, not our contract.
- **Model-name case sensitivity (minor):** `findModelByName` now matches with `LOWER(m.name) = LOWER(?)` (portable), so adding "IPHONE 15 PRO MAX" when "iPhone 15 Pro Max" exists returns 409 and no second row is created (test written first — it created a duplicate before the fix). This also makes `addModel`'s existing-row short-circuit case-insensitive.
- **Not in scope, noted for the Postgres migration:** the search domain's `LIKE` filters rely on SQLite's ASCII case-insensitive `LIKE`; Postgres `LIKE` is case-sensitive, so that path wants `ILIKE`/`LOWER()` at migration time. Same class of issue as arch-E but outside this ticket's grep list.
- Full suite 228/228 (219 prior + 9 new), `tsc --noEmit` (server + web) clean, `npm run build` clean.
