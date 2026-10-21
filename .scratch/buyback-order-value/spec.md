# Spec: buyback order value (not per-part dispositions)

## Problem

The buyback Complete flow (ticket 27) asks for a per-part disposition —
`sold` with a hand-entered sale price, or `rejected` — plus a per-part note.
In practice the supplier pays one lump sum for the shipment; nobody records
which parts were accepted or what each one fetched. The per-part entry is
friction that produces data nobody trusts or uses.

## Decision

A Buyback Order completes with **one hand-entered value for the whole
order** — the recovery revenue. We do not track which individual parts were
accepted or rejected, nor per-part prices.

- `buyback_orders` gains `order_value_cents` (NULL while open, set at
  Complete; the migration backfills already-complete orders with the sum of
  their recorded per-part sale prices — the revenue record stays truthful).
- `buyback_order_parts` loses its settlement columns
  (`disposition`, `sale_price_cents`, `disposition_note`, `settled_at`);
  it becomes the pure attachment record (which parts shipped on which order).
- On Complete (any user, required note, required order value ≥ 0): every
  part becomes Unavailable through the part-status module — unchanged — and
  the order records its value with a `buyback.settled` timeline event.
- The buyback-recovery report and CSV become per-order: completed orders
  with their entered value, one revenue total. The sold/rejected split goes.
- The open-order estimate (10% of parts value) and everything upstream
  (pool, override, scan-to-add, in-transit guards) is unchanged.

## Rejected alternatives

- Keep the columns and stop using them — dead schema lies about the domain
  (review standard: silent fallbacks are defects).
- Default the value to 0 when omitted — a settlement never guesses; the
  value is entered on purpose, even when it is 0.
