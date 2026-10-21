# 04 — PO display: pre-approval Quantity column + "Fulfills demand" labels

Status: ready-for-human

## Problem

Two display defects on `web/src/pages/PurchaseOrderDetailPage.tsx`:

1. While the PO is **Awaiting approval**, the order has not been placed — yet the lines table always shows Ordered / Received / Shortfall columns (`PurchaseOrderDetailPage.tsx:228-246`) and the header shows "Marked ordered: N demand record(s)" and "Shortfall: X units" chips (`:193-215`).
2. The lines table's "Fulfills demand" column renders a bare `#<demandId>` (`:250`) — neither device nor batch. The demand *record* already carries `device_id` (`demand_records`), and `serializeDemand` exposes `batch: {id, number}` and `device: {id}` (`batchparts/queries.ts:485-506`) — but not a human identifier for the device.

## Decisions (user-confirmed)

- While the PO is Awaiting approval: the lines table shows a **single "Quantity" column** (the line's `quantity`). From approval onward (In-transit / Partially received / Received / Closed): Ordered / Received / Shortfall columns as today.
- The header "Marked ordered" and "Shortfall" chips follow the same rule — hidden pre-approval.
- "Fulfills demand" renders **"Batch #N — <device identifier>"**, identifier = IMEI, else serial number, else asset ID (same precedence used elsewhere for device identification per CONTEXT.md). When the demand has no device (`device_id` null), fall back to the batch alone ("Batch #N"). No demand → "—" as today.

## Implementation notes

- Extend `serializeDemand` (or the PO line serialization that embeds it) with the device identifier — a join on `devices` is acceptable; do not add a stored copy.
- Keep the demand id available (tooltip/attr) — it remains the record key.

## Acceptance

- Awaiting-approval PO: one Quantity column; no shortfall/ordered/received anywhere on the page.
- Approved PO: Ordered/Received/Shortfall columns and header chips as today.
- Fulfills-demand shows "Batch #N — <identifier>" for device-linked demands, "Batch #N" for batch-only, "—" for none.

## Doc obligations

- `docs/logic-map.md`: purchase-orders route/UI notes if it documents column behavior.
- `docs/manual.md`: describe what the PO detail shows pre- vs post-approval.

## Comments

- Origin: grilling session 2026-10-05 (spec decision 3). User: "While the PO is in awaiting approval, ordered/shortfall/received should not be in the table because the order has not been placed yet. replace it with a single 'quantity column'."
- 2026-10-05, implemented (agent):
  - **Decision correction (user-confirmed during implementation):** the ticket text said the device identifier precedence is "IMEI, else serial number, else asset ID (same as elsewhere)" — but CONTEXT.md and the existing `deviceLabel` helpers use IMEI → Asset ID → serial. The user chose a third order for this display: **Asset ID → IMEI → serial** ("asset id's are easier to read"; "doesn't matter as long as one is present"). This ticket's label intentionally does NOT match the other deviceLabel helpers.
  - `server/domains/purchaseorders/serialize.ts` — `linesFor` now LEFT JOINs `demand_records` → `batches` → `devices` and each line carries `demand: { id, batchNumber, device } | null` (replacing the bare `demandId`). The device identifier is a read-time join, no stored copy (per ticket). `demand_id` on `purchase_order_lines` has no FK, so a join miss (broken database) throws loudly instead of rendering a silent "—".
  - `web/src/pages/PurchaseOrderDetailPage.tsx` — while Awaiting approval: single **Quantity** column and no "Marked ordered"/"Shortfall" header chips (close-with-shortfall was already approval-gated). From approval onward: Ordered/Received/Shortfall as before. "Fulfills demand" renders `Batch #N — <identifier>` (batch alone for a batch-only demand, "—" for none); the demand id remains available as the cell tooltip.
  - Tests: `server/tests/purchase-orders.test.ts` — new `seedDeviceDemand` helper (real batch → device → approve-all → approve → SQL demand row) and a test covering all three identifier precedences, the batch-only fallback, and the no-demand null. Existing `demandId` assertions updated to the new shape.
  - Docs: `docs/logic-map.md` (GET /:id route row) and `docs/manual.md` (new "Reading the PO page" subsection in section 7). CONTEXT.md needed no change — it states no identifier precedence.
  - Verified: `npm run typecheck` clean; `purchase-orders.test.ts` 32/32. Two OTHER tests fail on this working tree AND on clean `main` HEAD (pre-existing, unrelated to this ticket): `batchparts.test.ts > Need to Order demand > is listable per batch and globally outstanding` and `device-removal.test.ts > cancelled demand cannot be marked ordered on a PO…`. Flagged for triage (likely tickets 09/10 territory).
  - Note: mid-implementation, a concurrent session rewrote shared files while this ticket's uncommitted work was briefly stashed; the tree was fully reconstructed (verified byte-identical against the stash before dropping it) and the other agent's clobbered ticket-01 doc paragraphs were restored.
