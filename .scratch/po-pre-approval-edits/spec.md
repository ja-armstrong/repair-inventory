# PO pre-approval edits

Feature: a Purchase Order in **Awaiting approval** is a draft — the manager has
not signed off, nothing physical has happened (no expected serials, no
receipts, no parts moved). The paperwork should be revisable until the moment
of approval, and a mistaken draft should be deletable outright.

Spec (agreed with the user 2026-10-07):

1. **Revise lines** — `POST /api/purchase-orders/:id/lines`, any signed-in
   user, Awaiting approval only. The body is the SAME line schema as creation
   (SKU, quantity ≥ 1, unit price, optional source, optional demand refs)
   plus a required note. The submitted set REPLACES the PO's lines: SKUs are
   added by adding lines, removed by omitting them, quantities (and unit
   prices/sources) adjusted by editing the entries. One transaction, one
   `po.lines_changed` timeline event (new line set + old count/total → new
   count/total + demand-link diff + note).

   Demand links (`purchase_order_demand`) are re-derived, not round-tripped:
   - New links = open demand records explicitly referenced by the submitted
     lines (same validation as creation: record open, its batch Open).
   - Kept links = previously-linked demands that are still open AND whose SKU
     still has a line in the new set.
   - Released links = previously-linked demands that are no longer open OR
     whose SKU no longer has a line — they return to the outstanding queue.
   Rationale: the link table is PO-grain (only each line's first demand ref
   is stored per line), so per-line demand sets cannot round-trip; the
   SKU-based rule is derivable server-side and behaves correctly in every
   case (quantity bump keeps the link; removing the only line for that SKU
   releases it; a cancelled/fulfilled demand is pruned).

2. **Delete** — `DELETE /api/purchase-orders/:id`, any signed-in user,
   Awaiting approval only (409 otherwise, 404 unknown). HARD delete: demand
   links, lines, tracking entries, the PO's timeline events, and the PO row
   all go in one transaction. No note required — a note with nothing left to
   attach to is theater; the status gate is the record. Sequential PO numbers
   may be reused (MAX+1). Released demands (deleted links) return to the
   outstanding queue automatically.

Out of scope: editing purpose/sources/shipping/tracking (tracking is already
appendable; shipping has its own manager route); editing after approval (the
approval is what freezes the paperwork — only the shipping cost may still
move, per its own rule).

Test seams (agreed): HTTP only, per the repo's testing decision — both routes
tested through `supertest` in `server/tests/purchase-orders.test.ts`.

Tickets:

- `issues/01-revise-lines.md` — the revise-lines route + demand-link rule.
- `issues/02-delete-po.md` — the delete route.

Web: an "Edit lines" editor and a Delete control on the PO detail page while
Awaiting approval; a timeline description for `po.lines_changed`; the shared
line-fields component extracted from the create page.
