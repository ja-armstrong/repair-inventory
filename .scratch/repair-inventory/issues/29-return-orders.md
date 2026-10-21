# 29 — Return orders, In-Transit part status, and order estimates

**Status:** ready-for-human

## Spec

Under the RMA tab, allow the creation of **Return orders**: like RMA orders,
but they take **Available** parts and convert them to **Unavailable** when
the order is submitted (Completed). A Return order books each part's price as
revenue in reports — no manual entry — because the shop keeps the credit for
a returned unit.

RMA and buyback recoveries change shape: their received value is entered
manually when the vendor/supplier accepts the shipment (already true —
credits/sale prices are recorded at Complete), and while an order is open its
**estimated value** is displayed: 50% of the parts'-price sum for an RMA
order, 10% for a buyback order. Return orders display 100% (the committed
revenue).

To make "physically gone with an order" true at a glance, serialized parts
gain the **In-Transit** status: scanning a part onto an open RMA, buyback,
or return order moves it Available/RMA/Buyback → In-Transit, and completing
the order moves it In-Transit → Unavailable. Purchase-order stock keeps its
current flow — PO expected serials are not serialized parts yet — but batch
device rows no longer lie: Need-to-Order demand already marked ordered shows
its in-transit PO instead of reading "need to order".

## Decisions (from the user)

- Return order lifecycle: In-Transit → Complete, exactly like RMA; the
  "submission" is the Complete action; no per-part dispositions.
- Revenue price source: the part's **effective price** (Part Price override
  if set, else the SKU price), snapshotted onto the order line at Complete.
- Estimates: open orders in the RMA and Buyback lists/details — 50% (RMA),
  10% (buyback), computed server-side and sent on the order summary.
- New manager CSV report: returns revenue (completed return orders, per-part
  snapshotted price, interval total).

## Comments

- Implemented 2026-09-30. Migration 0018: `serialized_parts` rebuilt (full
  cascade over its five children) with `in_transit` in the status CHECK, a
  backfill flipping parts attached to open RMA/buyback orders to
  `in_transit`, and the new `return_orders` / `return_order_parts` pair
  (CHECK: `price_cents` set exactly when `settled_at` is).
- `parts/status.ts`: `in_transit` joins the vocabulary ("In-Transit"); new
  `via` values `order_scan` and `return_complete`; the bare endpoint's
  per-kind attachment refusals are replaced by the one three-table
  `openInTransitOrder` read (RMA/buyback/return) plus a refusal to SET
  in_transit and a loud throw on an in_transit part no open order claims.
- `rma` / `buybacks` domains: a scan now moves RMA/Buyback → In-Transit
  through `changePartStatus` (was: part kept its pool status); Complete
  settles from In-Transit; the pool endpoints list pool parts plus their own
  orders' In-Transit parts; order summaries carry `partsValueCents` and
  `estimatedValueCents` (50% / 10%, server-computed, display-only); order
  parts expose their effective price.
- New `returns` domain (`/api/return-orders`, registered in bootstrap):
  create/scan/notes/timeline mirror the RMA shape, the scan takes AVAILABLE
  parts, and Complete (one note, no dispositions) settles every part
  Unavailable while snapshotting its effective price onto the order line as
  booked revenue.
- `batchparts/queries.ts`: demand rows carry `orderedOn { poNumber, poStatus }`
  (the PO already covering them) so the device panel says "in transit on
  PO #N", never the stale "Need to Order".
- `audits/counting.ts`: exemption reads the `in_transit` status directly
  (the `onInTransitRma`/`onInTransitBuyback` order-table probes are gone);
  scan-wins covers in_transit.
- `reports`: new `returnsRevenueReport` + `GET /api/reports/returns-revenue`
  CSV. `search`: return orders join the number search.
- Web: RmaPage becomes the RMA & Return orders tab (estimate column,
  Return-orders create/list), new ReturnDetailPage at `/rma/returns/:id`,
  RMA/Buyback details show estimated recovery and per-part price, DeviceParts
  shows the carrying PO on ordered demand, SearchPage gains In-Transit and
  the Return-orders group, Timeline labels the return/buyback events,
  ReportsPage gains the returns-revenue download.
- Tests: new `server/tests/returns.test.ts` (19); rma/buybacks/audits/
  search/purchase-orders suites updated to the In-Transit flow and the new
  fields; admin migration-count assertions made dynamic.
  `npm test` 424 passing; both typechecks and `npm run build` clean.
- Standing docs updated in the same change: README, CONTEXT.md (Return
  Order, In-Transit, revised RMA/Buyback/Note/Tech entries),
  docs/logic-map.md, docs/data-model.md, docs/manual.md.
