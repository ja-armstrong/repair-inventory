# 07: Purchase orders — create, approve, track

**What to build:** The PO record and its paperwork half. A tech creates a PO with a purpose (free text with suggestions from past purposes), lines of SKU/quantity/unit price, sources, shipping cost, and any known tracking entries (carrier + number, multiple allowed). The create flow prompts with outstanding Need to Order demand and can pre-fill lines (including supplier links) from it, marking demand as being ordered. Statuses: Awaiting approval → In-transit (manager approval required, with required note), with tracking entries appendable. Chronological status notes are required on every status change, same timeline pattern as batches. Sequential PO numbers.

**Blocked by:** 03 (parts catalog and inventory). Independent of the batch tickets — do not touch the batches domain.

**Status:** ready-for-human

- [x] PO creation captures purpose, lines (SKU, quantity, unit price), sources, shipping cost, and tracking entries; sequential number assigned; required opening note
- [x] The create UI/API surfaces outstanding demand and pre-fills lines from selected demand records (supplier link carried); ordered demand is marked so it stops appearing as outstanding
- [x] Only managers move a PO out of Awaiting approval (to In-transit), with a required note; techs are refused
- [x] Status changes require notes; the timeline merges notes and events, immutable
- [x] Purpose and source inputs suggest values from history
- [x] PO UI: create (with demand prompt), list, detail with timeline, tracking entry management, approve action for managers
- [x] API tests cover creation validation, demand prompt/consumption, manager-only approval, and required notes on transitions

## Comments

**Endpoints** (all session-gated under `/api/purchase-orders`, domain registered in `server/bootstrap.ts`):

- `POST /api/purchase-orders` — create: purpose (required), opening note (required), sources, shippingCost, ≥1 line (skuId, quantity, unitPrice, optional per-line source, optional demandId), tracking entries. Sequential PO numbers (MAX+1 in the create transaction, like batches). Money as integer cents via the parts domain's `parsePriceToCents`.
- `GET /api/purchase-orders` — list summaries (lineCount, trackingCount, totalCents/total) newest-first.
- `GET /api/purchase-orders/:id` and `GET /api/purchase-orders/:id/timeline` — detail and the merged timeline (detail embeds events too).
- `POST /api/purchase-orders/:id/notes` — note.added event, 201.
- `POST /api/purchase-orders/:id/tracking` — append carrier+number (any status; multiple allowed), po.tracking_added event.
- `POST /api/purchase-orders/:id/approve` — `requireManager`; required note; Awaiting approval → In-transit only (409 otherwise); stamps approved_by/approved_at; `po.status_changed` event `{from, to, note}`. Receiving transitions (Partially received / Received / Closed) are deliberately admitted by the status CHECK in migration 0006 but not implemented — ticket 08 extends the machine.
- `GET /api/purchase-orders/suggestions` — distinct past purposes and sources (PO-level `sources` plus per-line `source`), freshest first.
- `GET /api/purchase-orders/demand` — outstanding Need to Order demand for the create prompt.

**Demand integration (ticket 05):** real, not tolerant-by-necessity anymore — their migration 0005 (`demand_records`) landed while this ticket was mid-flight, so `server/domains/purchaseorders/demand.ts` reads the actual shape (sku_id, batch_id, device_id, supplier, status). The integration is one-directional and additive: this domain NEVER writes their table. Marking demand ordered = a row in this domain's own `purchase_order_demand` link table (migration 0006, no FK to their table on purpose); outstanding = their open records minus linked ids. Their migration's comment anticipated exactly this ("a link to the PO line can be added there additively"). Demand ids on PO lines are validated when their table exists; the endpoint degrades to an empty list if the table is somehow absent.

**Timeline:** all writes through `recordEvent` (entity type `po`): `po.created`, `note.added` (the required opening note first, batch-style), `po.tracking_added`, `po.demand_marked`, `po.status_changed`. No edit/delete routes exist — immutability asserted in tests via 404s on attempted PUT/DELETE.

**Web UI:** `web/src/pages/OrdersPage.tsx` (list), `PurchaseOrderCreatePage.tsx` (demand prompt with checkboxes → pre-filled lines carrying the supplier link and offered SKU price; purpose/sources datalists fed by the suggestions endpoint; multi-entry tracking), `PurchaseOrderDetailPage.tsx` (lines, tracking table + append form, manager-only approve with note, notes + inline timeline). Routes `orders`, `orders/new`, `orders/:id` added to `web/src/main.tsx` (nav "Orders" already existed from the scaffold — AppLayout untouched).

**Tests:** `server/tests/purchase-orders.test.ts` (24 tests at the HTTP seam) — creation validation (purpose/note/lines/unknown SKU/bad price/quantity/shipping), sequential numbers and totals, event ordering, manager-only approval (tech 403, note required, 409 on re-approve, clock-stamped approvedAt), tracking appends, suggestions, and the demand integration (seeded rows against migration 0005's real shape: prompt lists them, PO create links + validates them, linked records stop appearing as outstanding).

**Full suite at close:** my file green, typecheck (server + web) green, `npm run build` green. Note for the reviewer: at the moment of this ticket's commit, `server/tests/audits.test.ts` (ticket 10, mid-flight in parallel) was failing in the full suite — foreign, reported, not touched.
