# 09: RMA orders

**What to build:** The RMA lifecycle. A tech creates an RMA order (required opening note) from a screen that lists all RMA-status parts; scanning (typing) a serial moves that part into the order (it stays RMA-status, now attached). The order moves In-Transit → Complete; on Complete, every part on the order becomes Unavailable — credited parts and RMA-rejected returns alike, distinguished by per-part disposition and note. Per-part credit values are recorded at completion for the recovery report. Sequential RMA numbers; status changes require notes; timeline merged and immutable like the others.

**Blocked by:** 03 (parts catalog and inventory). Independent of the batch and PO tickets — do not touch those domains.

**Status:** ready-for-human

- [x] RMA order creation lists all RMA-status parts; scanning a serial adds it to the order; non-RMA or already-added parts are rejected
- [x] Status flow In-Transit → Complete with required notes; any user may complete
- [x] On Complete, all parts become Unavailable with events; per-part disposition (credited with credit value / rejected) is recorded with notes
- [x] Credit values are queryable for reporting (sum of credits over an interval)
- [x] RMA UI: create, scan-to-add screen (scan-first input), detail with timeline, complete flow with per-part disposition entry
- [x] API tests cover scan validation, the Complete transition and part settlement, credit recording, and required notes

## Comments

Implemented in `server/domains/rma/` (migration `0007-rma-orders.sql`, 26 tests in `server/tests/rma.test.ts`, web `RmaPage` + `RmaDetailPage`). Notes for reviewers and later tickets:

- **Lifecycle:** creation → `in_transit` immediately (no draft/approval state — CONTEXT.md's lifecycle is In-Transit → Complete); the only transition is Complete, which any user (tech or manager) may perform.
- **Scan-to-add:** `POST /api/rma-orders/:id/parts` `{ serial }`. The part keeps its `rma` status (now attached); unknown serial → 404, non-RMA status → 409 (message names the current status), already on this/another open order → 409, complete order → 409. No note required for a scan — the scan is the record; events land on both the order timeline (`rma.part_added`) and the part timeline (`part.added_to_rma`).
- **Complete:** `POST /api/rma-orders/:id/complete` `{ note, parts: [{ serial, disposition: "credited"|"rejected", credit?, note }] }` — a note and a disposition entry are required for every part; credited parts require a money `credit` (parsed to integer cents via the parts domain's `parsePriceToCents` — a read-only import, no parts-domain edits); rejected parts must not carry one. Completion is one transaction: parts → `unavailable` (events on both timelines), settlement columns on `rma_order_parts`, `note.added` + `rma.status_changed` on the order. Completing an order with no parts is refused.
- **Reporting seam for ticket 12:** `GET /api/rma-credits?from&to` (manager-only) returns `{ from, to, totalCreditCents, creditedParts, rejectedParts, orders: [{ id, number, completedAt, partCount, creditCents }] }` — interval-filtered on `completed_at`, inclusive bounds, per-order breakdown. Per-part detail (disposition, `creditCents`, `dispositionNote`) rides on `GET /api/rma-orders/:id` → `parts[]`.
- **Events recorded** (entity_type `rma` on the order; `part.*` on the part): `rma.created`, `rma.part_added`, `rma.part_settled`, `rma.status_changed`, `part.added_to_rma`, and `part.status_changed` (in the parts domain's shape, payload extended with `rmaOrderId`/`rmaNumber`/`disposition`/`creditCents`) — notes merge as `note.added` events like batches. No edit/delete endpoints anywhere (immutable timeline).
