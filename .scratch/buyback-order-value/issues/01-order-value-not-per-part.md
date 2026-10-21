# 01: Complete a buyback order with one order-level value

**What to build:** Replace the per-part disposition + sale-price Complete
flow with a single hand-entered order value. See `.scratch/buyback-order-value/spec.md`.

- [x] Migration 0027: `buyback_orders.order_value_cents` (NULL while open,
      backfilled for complete orders as the sum of recorded sale prices);
      `buyback_order_parts` rebuilt as the attachment record (settlement
      columns dropped)
- [x] Complete route: `{ note, orderValue }` — both required; every part
      Unavailable via `changePartStatus`; `buyback.settled` order event
- [x] Order summary/detail serialization: `orderValueCents`; loud failure if
      a complete order reads NULL
- [x] Reports: `buybackRecoveryReport` per-order (order, completed_at,
      value, total); CSV reshaped
- [x] UI: BuybackPage + BuybackDetailPage — single value input, no
      disposition columns; Timeline `buyback.settled` case
- [x] Tests reworked (complete matrix, totals, CSV, migration backfill);
      full suite, typecheck, build green
- [x] Docs in the same commit: CONTEXT.md, logic-map, data-model, manual

**Status:** ready-for-human

## Comments

**Migration 0027** is deliberately light: `order_value_cents` is a plain
`ADD COLUMN` (no CHECK — SQLite cannot ADD one via ALTER, the 0021/0026
pattern; the non-negative rule is enforced at the single write site, the
Complete transaction's `parsePriceToCents`). The backfill runs BEFORE the
`buyback_order_parts` rebuild so the old `sale_price_cents` column still
exists to sum; the old table CHECK guaranteed sold rows carry a price and
rejected rows carry none, so the sum is exactly the revenue the report
would have shown. `buyback_order_parts` is rebuilt as the attachment record
(id, order, part, added_at, added_by) — drop/copy/rename, nothing
references it. A backfill test reconstructs the pre-0027 world (the
audits.test.ts 0026 pattern: delete the ledger row, drop the column, restore
the old-shape table) and re-applies exactly 0027.

**Domain** (`buybacks/index.ts`): `completeSchema` is now `{ note,
orderValue }` — the value is REQUIRED even when it is 0 (a settlement never
guesses; enter 0 for a fully-refused shipment). The per-part entry
validation matrix (dispositions, per-part prices, missing serials) is gone
with the feature it validated. The transaction settles every part
Unavailable through `changePartStatus` (`via: "buyback_complete"`,
`expectedFrom: "in_transit"` — unchanged), records ONE `buyback.settled`
event `{ orderValueCents }` on the order timeline (replacing per-part
`buyback.part_settled`), then the note and the status transition.
`serializeOrderSummary` throws if a complete order reads NULL value — the
loud-failure seam for the CHECK-less column. Summary field renamed
`saleCents` → `orderValueCents` (NULL while open).

**Reports**: `buybackRecoveryReport` now reads `buyback_orders` directly —
one row per completed order (number, completed_at, value), loud on a
complete order with NULL value, single `totalValueCents`. The CSV is three
columns (Buyback order / Completed at / Value) with the total under Value;
the sold/rejected sections are gone.

**UI**: the Complete flow is one "Order value (USD)" input plus the
completion note; the parts table drops its Disposition/Sale price/Note
columns; the order list shows the entered value for complete orders and the
10% estimate for open ones; `Timeline.tsx` renders `buyback.settled` as
"settled the order for $X". Reports page description updated.

**Tests** — `buybacks.test.ts` (19): the Complete matrix reworked (missing
value, >2-decimals value, negative value, per-part key shape pinned, the
`buyback.settled` payload, parts Unavailable, double-complete 409 with a
valid body, scan-after-complete 409); a new empty-order refusal test; the
summary test asserts NULL-while-open; the CSV test asserts order
granularity (no serial lines); the migration backfill describe. Full suite
596/596, typecheck and build green.

**Docs**: CONTEXT.md Buyback Order (one hand-entered value, no per-part
dispositions), logic-map (buybacks intro, detail/complete routes, state
machine, report row), data-model (0027 row, both buyback tables),
manual §8 (Complete steps) and §12 (report list), plus stale comments in
`parts/status.ts`, `returns/index.ts`, and `returns.test.ts`.
