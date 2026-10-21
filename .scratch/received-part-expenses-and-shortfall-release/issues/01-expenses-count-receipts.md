Status: resolved

# 01 — Expenses count PO receipts

`server/domains/reports/queries.ts expenseReport` currently builds expense
lines from batch-close settlement events (consumed parts, split by intake
source) plus consumable usage plus PO shipping. Change the basis to RECEIPTS:

- Serialized: one line per received expected serial —
  `purchase_order_expected_serials` with `part_id IS NOT NULL`, interval on
  `received_at`, amount = the line's `unit_price_cents` (the amount actually
  paid for that unit, also stamped on the part), reference `PO #N`, detail
  `serial — SKU`. Category `Received part`.
- Consumables: one line per `po.consumable_received` event in the interval,
  amount = quantity × the line's unit cost (lines are frozen after approval,
  so the received-under price IS the paid price), reference `PO #N`, detail
  `SKU x quantity`. Category `Received consumable`. Loud failure when the
  event's line no longer exists or the payload shape changed.
- PO shipping: unchanged (at creation).
- Consumable usage lines: REMOVED (receipt-based now; usage would
  double-count).
- Non-purchased consumption section: unchanged.

## Comments

- Implemented in `expenseReport`; `consumedPartCost` survives solely for the
  non-purchased listing. `ExpenseLine.category` widened to the three receipt
  categories.
- reports.test.ts scenario extended: PO #2 approved 09-04T10:00, its battery
  received 09-24T09:00 (deliberately AFTER the 09-23 audit close so the new
  Available unit never enters the audit due-pool and the shrink fixture is
  untouched); PO #3 gained an adhesive line, approved 09-30T23:30, 4 units
  received 09-30T23:45. New interval total 64.65
  (9.99 shipping + 45.00 battery + 3.33 shipping + 6.00 consumables).
- The old "removed usage stops counting" test replaced: usage recording and
  removal must now leave the expenses CSV byte-identical.
