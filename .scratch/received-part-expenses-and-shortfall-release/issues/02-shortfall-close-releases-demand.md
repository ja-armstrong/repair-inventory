Status: resolved

# 02 — Shortfall close releases demand

`closeWithShortfall` (purchaseorders/receiving.ts) only flips the PO to
Closed. A demand the PO marked ordered stays hidden from the outstanding
queue forever (outstanding = open demand minus `purchase_order_demand` ids),
even though the goods never arrived.

Change: on close, delete the PO's `purchase_order_demand` links. Every
still-open linked demand returns to BOTH queues (`GET /api/demand`,
`GET /api/purchase-orders/demand`) automatically — no `demand_records` write,
the link subtraction IS the mechanism. The close event names the released
ids (`demandReleased`, same shape the line-revision event uses).

## Comments

- All links are deleted (fulfilled/cancelled links are inert — the queue
  reads `status='open'` only — and the revise route prunes them the same
  way); `demandReleased` records only the ids that were open at close.
- Test in purchase-orders-receiving.test.ts: two demands linked to one line
  (`demandIds`), one unit received (fulfills the line's first demand), close
  with shortfall → the second demand is back on both queues with
  `orderedOn` null, the first stays fulfilled, the link rows are gone, and
  the close event carries `demandReleased: [second]`.
