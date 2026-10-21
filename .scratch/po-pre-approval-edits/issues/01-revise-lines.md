# Revise PO lines while Awaiting approval

Status: ready-for-human

A PO in Awaiting approval is revisable: its line set can be replaced (SKUs
added/removed, quantities/prices adjusted). See `../spec.md` for the agreed
contract, including the demand-link re-derivation rule.

Seam: `POST /api/purchase-orders/:id/lines` (HTTP only).

Server:
- Extract the create route's per-line validation (price parse, SKU existence,
  demand refs open + batch Open) into ONE shared helper so create and revise
  cannot drift.
- Refuse non-Awaiting-approval POs with 409; loud guard that no line has
  received quantities (impossible pre-approval — if it ever holds, crash
  loudly rather than delete receipts).
- One `po.lines_changed` event per revision: new line set, previous → new
  line count and total, demandMarked / demandReleased ids, the note.

Tests: revise happy path (add/remove/adjust), refusals (status 409, missing
note 400, empty lines 400, unknown SKU 400, bad price 400), demand links
(kept on same-SKU quantity bump, released when the SKU's line disappears and
the demand returns to the outstanding queue, newly marked when a line
references a demand, non-Open-batch demand refused).

## Comments

- Implemented as specified. Shared validation lives in
  `server/domains/purchaseorders/lines.ts` (`resolveLines`): price parsing,
  SKU existence, and demand-ref checks in one function used by BOTH the
  create route and the revise route — one copy of the rule.
- Demand-link diff implemented exactly as the spec's three bullets; the
  `purchase_order_demand` rows are the only store of non-first demand refs,
  so the diff reads them joined to `demand_records` (id, sku_id, status).
- The revise route reuses `lineSchema` verbatim, so the wire contract for a
  line is identical on create and revise.
- TDD cycles ran red→green per test group; see the test file's
  "POST /:id/lines" describe block.
- Web: extracted the create page's line fieldset into
  `web/src/components/PoLineFields.tsx` — the ONE line editor row, used by
  both the create page and the detail page's editor. Changing a line's SKU
  clears its demand refs (a Need to Order record belongs to the SKU it was
  filed for); the server re-derives the link set regardless.
- The detail page (Awaiting approval only) shows an "Edit lines" editor:
  drafts initialized from the current lines, add/remove rows, required note,
  Save/Cancel. A `po.lines_changed` timeline description was added to the
  shared Timeline renderer (new count/total, demand diff, note).
- Code review round (two-axis) applied:
  - The SKU-name read in the revise transaction is now LOUD (throws) instead
    of fabricating `SKU #N` — review standard: no silent fallbacks.
  - The event's totals are named `previousLinesTotalCents`/`linesTotalCents`
    (lines only — shipping is separate and unchanged). `po.created`'s
    `totalCents` includes shipping, so the same key never carries two
    meanings; the timeline description says "lines total".
  - The event's line snapshots now carry the line's `source`.
  - The demand-ref spread (×3) is single-sourced as `demandRefs(line)` in
    lines.ts; the line snapshot shape is `LineSnapshot`.
  - `PoLineFields`' demand-keep condition written plainly.
  - `docs/manual.md` (standing doc) updated: section 7 "Changing or deleting
    a draft PO" + the who-can-do-what table.
  - Not taken: extracting the parse→404→409 route gate into a helper — every
    existing PO route repeats that shape inline; two routes adopting a helper
    would be its own inconsistency.
