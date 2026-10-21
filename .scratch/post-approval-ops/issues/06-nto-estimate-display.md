# 06 — Approval cost: show NTO estimate instead of $0

Status: ready-for-human

## Problem

When a part is in Need-to-Order, the NTO path reserves nothing and adds no cost — correct for `approved_cost_cents` (a demand is an estimate, not a signed-off cost; `batchparts/index.ts:644`), but the approval surfaces show **$0**, which understates what the manager is approving in the dangerous direction. The SKU's current price already rides along in the demand serialization (`batchparts/queries.ts:488-490`).

## Decision (user-confirmed)

Display-only change — the stored cost semantics do NOT change:

- Wherever a demanded (not-yet-owned) part contributes to a cost display — device Parts Cost line, approval summary, `approved_cost` segment — show **"NTO — est. $<SKU price>"** instead of a bare $0.
- The estimate never enters `approved_cost_cents` and never counts toward Price Add Limit headroom (existing exemptions stay).
- When the part arrives, ticket 09 amends the approval cost to the part's actual price — this ticket is the honest-display half of that contract.

## Implementation notes

- Find every site that renders device parts cost / approval cost (`BatchDetailPage.tsx:338-345` status line, approval section `:359+`, `serialize.ts` approval helpers) and thread the "estimated, not signed-off" state through explicitly — no hidden magic numbers.
- Keep $0 *stored*: this ticket must not touch cost computation, only presentation.

## Acceptance

- A device with an open demand shows "NTO — est. $X" on its Parts Cost and in the approval view; stored approved cost unchanged.
- After fulfillment + amendment (ticket 09), the display shows the real cost.
- Tests (serialization-level) cover the estimate field's presence and that it is excluded from cost sums.

## Doc obligations

- `docs/manual.md`: what the approval cost display means when a part is NTO.

## Comments

- Origin: grilling session 2026-10-05 (spec decision 7). User chose honest-display over signing off estimates: "(b) — honest display without silently inflating the signed-off cost."
- 2026-10-05, implemented (agent):
  - File drift: the ticket named `server/domains/batchparts/serialize.ts` "approval helpers" — that file did not exist; the approval-cost serialization lives in `server/domains/batches/serialize.ts` (`serializeBatchSummary` → `approvedCost`, untouched: stored semantics unchanged) and the per-device parts listing serializes in `batchparts/index.ts`. Created `server/domains/batchparts/serialize.ts` as the ticket intended: the ONE estimate contract — `openDemandEstimateCents(DemandJoinRow[])` (open records only; a fulfilled/cancelled demand is not even an estimate) and `ntoEstimateLabel` ("NTO — est. $X", null when nothing is outstanding).
  - `server/domains/batchparts/index.ts` — `GET /:batchId/parts` (read route only) now carries the estimate per device as its OWN fields: `openDemandEstimateCents` + `openDemandEstimate`. Nothing in `queries.ts` was touched; the SKU price already rode along in `serializeDemand`.
  - `web/src/components/DeviceParts.tsx` — `DevicePartsData` gains the two fields; the parts panel heading shows the estimate next to Parts Cost, never inside it.
  - `web/src/pages/BatchDetailPage.tsx` — the client no longer re-prices demand from `sku.priceCents` (that hidden derivation is deleted): the device-grid Parts Cost column, the approval summary (`currentPartsCost`), and the batch status line all read the server-computed estimate fields; the batch total is the sum of the per-device fields, formatted by one local `ntoEstimateLabel` helper. Status line shows "· NTO — est. $X" beside the stored approved cost whenever open demand exists.
  - Tests: `server/tests/batchparts.test.ts` — extended the `GET /:batchId/parts` listing test (estimate present at the SKU's current price, labeled, and excluded from `partsCostCents`; zero-device gets `null`) and a new test that the estimate drops out when the demand is cancelled while the stored cost stays $0.
  - Docs: `docs/manual.md` (Parts Cost paragraph + approval bullet: what the NTO estimate means) and `docs/logic-map.md` (GET /:batchId/parts route row). CONTEXT.md and docs/data-model.md needed no change — no rule, table, or column changed.
  - Verified: server + web `tsc --noEmit` clean; full suite 497/497 (496 pre-existing + 1 new).
