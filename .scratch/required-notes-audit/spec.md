# Spec: Required-notes audit — five note requirements dropped

An audit of every note the server requires (25 flows, see the conversation
audit table). The owner reviewed each and said keep or no. Five requirements
are dropped; everything else stays exactly as it was.

## Decisions

| # | Flow | Decision |
|---|------|----------|
| 1 | PO shipping-cost change note | **dropped** — the `po.shipping_changed` event itself records old → new; the change is never silent even noteless |
| 2 | PO create opening note | kept |
| 3 | PO revise-lines note | **dropped** — the line diff is the record |
| 4 | PO close-with-shortfall note | kept |
| 5 | PO approve note | kept as-is (already optional) |
| 6 | Batch create opening note | kept |
| 7 | Batch approve note | **dropped** — the sign-off is the status change itself (same reasoning as the PO approval, .scratch/po-approval-ux) |
| 8 | Remove device from batch note | kept |
| 9 | Terminal-status resolution notes | **dropped** — the status change itself is the record |
| 10 | Open-batch amendment note (add part / pre-attach / consumable usage) | **dropped** — the amendment event records that the approval moved |
| 11–25 | everything else (swaps, removals, demand cancel, part status/price, salvage, SKU kind/buybackable/delete, RMA/return/buyback create+complete, scan-wins, the shared notes endpoint) | kept |

## The one contract every dropped requirement keeps

Following the PO-approval precedent: a note is **optional, but a
given-but-blank note is refused loudly** — never silently dropped. A noteless
change records NO note key in its event payload at all.

## Consequence accepted

- A Denied-Repair-adjacent flow: a device can now reach Repaired /
  Unrepairable / Additional issues present with NULL `resolution_notes`
  (removes the exception language that treated Denied Repair as the lone
  optional case — all terminal statuses are now equal).
- Retriage with no resolution notes still creates the continuation batch
  with its opening note (required by #6, kept): the synthesized note omits
  the notes suffix when there are none.
- `partEditPermissions.noteRequiredOnAdd` was removed entirely (the UI label
  is now plain "(optional)") rather than hardcoded false — no dead flag.
