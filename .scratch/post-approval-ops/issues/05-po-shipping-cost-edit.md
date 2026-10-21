# 05 — PO shipping cost: addable/editable after approval

Status: ready-for-human

## Problem

There is **no PATCH route on purchase orders at all** — `shipping_cost_cents` is set at creation (`server/domains/purchaseorders/index.ts:123-124`, omitted → 0) and can never change, before or after approval. Real shipping costs are known when the package ships, i.e. after approval.

## Decision (user-confirmed)

Add a shipping-cost edit path on POs:

- **Manager-only** (same predicate as other manager powers; admin passes).
- **Required note** — consistent with every PO state change.
- Allowed in any status except **Closed** (In-transit / Partially received edits are the point of the feature; Awaiting approval edits are fine too).
- Value: integer cents, `>= 0` (matches the column CHECK).
- PO total recomputes (`server/domains/purchaseorders/serialize.ts:168-185` already sums lines + shipping).
- Timeline records the change (old → new + note), merging with the existing event timeline.

## Implementation notes

- Do not build a general PO-field PATCH — one explicit route for shipping cost keeps the contract narrow. Route shape follows the domain's existing `POST /api/purchase-orders/:id/...` action style.
- The UI affordance on `PurchaseOrderDetailPage.tsx` shows for managers only, per the domain's current-user pattern (see how the approve form gates at `:307-328`).
- Check whether expense reporting reads shipping anywhere (`intake` source accounting counts PO intake) and keep the numbers flowing through the existing total, not a parallel one.

## Acceptance

- Manager can set shipping cost on an In-transit PO with a note; total updates; timeline records it.
- Tech gets 403; Closed PO refuses; negative/invalid values 400.
- Tests cover permission, status gate, note requirement, total recomputation.

## Doc obligations

- `CONTEXT.md` **Purchase Order** definition: shipping cost now editable pre-Closure by manager with note.
- `docs/data-model.md` (`purchase_orders` notes), `docs/logic-map.md` (new route), `docs/manual.md`.

## Comments

- Origin: grilling session 2026-10-05 (spec decision 6). User asked for "after batch approval"; grilling established shipping cost is PO-only and that no PO edit path exists at all — the decision covers any pre-Closed status, manager-only with note.
- 2026-10-05, implemented (agent):
  - `server/domains/purchaseorders/index.ts` — new `POST /api/purchase-orders/:id/shipping-cost` (`requireManager`, admin passes — the same predicate as approve), one explicit route, no general PATCH. Body: `{ shippingCost, note }` (note required). Value parsed with the same `parsePriceToCents` used at creation: dollars at the edge, integer cents in storage, negatives/malformed/over-precise → 400 (matches the column CHECK `>= 0`; 0 is legal). Status gate: any status except **Closed** → 409 (Closed is the terminal historical record of what was spent). Write is one transaction: `UPDATE purchase_orders SET shipping_cost_cents` + one `po.shipping_changed` event `{ from, to, note }` in the same immutable timeline.
  - Total recomputation verified, not duplicated: `serialize.ts` `poDetail` computes `totalCents = linesCents + shipping_cost_cents` and the route just re-serializes. Expense reporting (`server/domains/reports/queries.ts:200-220`) reads `purchase_orders.shipping_cost_cents` directly (category "PO shipping"), so the edit flows through the existing number — no code change there, no parallel total.
  - `web/src/pages/PurchaseOrderDetailPage.tsx` — "Shipping cost" form (new amount + required note) shown only when `manager && status !== "Closed"`, following the approve form's existing role gate (`user?.role === "manager"`). Built on top of the ticket-04 Quantity/demand-label changes, nothing reverted.
  - Tests: `server/tests/purchase-orders.test.ts` — new `POST /api/purchase-orders/:id/shipping-cost` describe (7 tests): tech 403 + no event, note required 400, negative/malformed/over-precise 400 (and 0 accepted), unknown/malformed id 404/400, pre-approval set with total recompute (2×$12.34 + $4.50 = $29.18) and timeline order `po.created, note.added, po.tracking_added, po.shipping_changed`, In-transit set (the real-freight case; approval's `po.serials_assigned` event sits between), and Closed refusal (409, column unchanged, no event). Closed fixture built through the real HTTP flow: approve then close-with-shortfall on a fully-unreceived PO.
  - Docs: `CONTEXT.md` (Purchase Order definition — manager edit with note pre-Closed), `docs/data-model.md` (purchase_orders note: the one PO field with an edit path, event shape, single source of the total), `docs/logic-map.md` (new route row, manager, gate + event), `docs/manual.md` (new "Changing the shipping cost" subsection in section 7 + "Who can do what" row).
  - Verified: `npx vitest run server/tests/purchase-orders.test.ts` 39/39; `npm run typecheck` clean. The two known pre-existing failures elsewhere (batchparts.test.ts listable-per-batch; device-removal.test.ts cancelled-demand-marked-ordered) were not touched and remain as documented on ticket 04.
