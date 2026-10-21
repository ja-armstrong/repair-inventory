# Delete a PO while Awaiting approval

Status: ready-for-human

A mistaken draft PO can be deleted outright. See `../spec.md` for the agreed
semantics (hard delete, any user, Awaiting approval only).

Seam: `DELETE /api/purchase-orders/:id` (HTTP only).

Server:
- One transaction: delete `purchase_order_demand` links, `purchase_order_lines`,
  `purchase_order_tracking`, the PO's `events` rows (entity_type 'po'),
  then the `purchase_orders` row.
- 404 unknown id; 409 any status except Awaiting approval.
- No note required (nothing persists to carry it); the status gate is the
  record. Sequential numbers may be reused (MAX+1) — assert that behavior.

Tests: delete removes the row and all children (direct db asserts on the
empty tables), GET/list no longer show it, a linked demand returns to the
outstanding queue, refusal after approval (409), unknown id (404), number
reuse after delete.

## Comments

- Hard delete as agreed; no soft "voided" status — the CHECK constraint,
  list queries, and expense reporting stay untouched.
- Deletion order is children → events → parent so FK enforcement (where on)
  cannot trip; the transaction makes it atomic.
- The demand link rows simply cease to exist, so the outstanding queue
  (open demand minus link ids) shows them again with no extra write.
- Web: a "Delete draft PO" button on the detail page while Awaiting
  approval, behind a `window.confirm` (the AuditsPage pattern) that names
  what is removed and that covered demands become outstanding again; on
  success it navigates back to the orders list.
