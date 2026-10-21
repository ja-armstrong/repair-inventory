# Fulfillment auto-unblocks a Parts-needed device

Status: ready-for-human

When a device's demand record is fulfilled, automatically move the device's
Repair Status from **Parts needed** to **Awaiting repair**. See `../spec.md`
for the agreed contract (last-open-need-only, Parts-needed-only, one shared
implementation called by both arrival doors).

Seam: `batches/lifecycle.ts autoUnblockAfterDemandFulfilled` (module import
from both `purchaseorders/receiving.ts` and `parts/intake.ts`).

Server:
- One function next to `setRepairStatus`; no-ops unless the device is in
  Parts needed with no other open demand; loud throw on an unexpected
  refusal (mirrors attach.ts's auto-move error style).
- Called after the guarded `open → fulfilled` flip + `demand.fulfilled`
  event in BOTH doors.

Tests: PO receipt unblocks a Parts-needed device (event recorded); a second
open need keeps it blocked until it too is fulfilled; a device pulled back
to In progress is not rewound; intake parity (salvage).

## Comments

- Implemented as specified. `autoUnblockAfterDemandFulfilled` lives in
  `batches/lifecycle.ts` beside `setRepairStatus` (the one writer of
  `devices.repair_status`) and reuses `listOpenDemandForDevice` — the same
  population the status endpoint's unblock guard checks, so the endpoint
  and the auto-move can never disagree about "still blocked".
- Both doors call it after their own fulfillment flip; the seam
  (`autoReserveOntoDemandDevice`) still touches no status — its doc comment
  now points at the fulfillment step as the status's home.
- reason on the `device.status_changed` event is `need fulfilled`,
  mirroring the attach path's `need to order`.
- The PO-receipt tests seed "Parts needed" with a direct SQL UPDATE (the
  same test-setup convenience the file already uses for demand rows).
- TDD: the three receiving tests + the intake parity test ran red first
  (device stayed Parts needed), then green after the implementation.
- Web (one small change): `Timeline.tsx` now appends the event's `reason`
  to `device.status_changed` ("moved device from Parts needed to Awaiting
  repair (need fulfilled)") — without it an automatic move reads as the
  receiver's manual act. This also surfaces the attach path's existing
  "need to order" reason. No web test asserted the old string.
- Standing docs updated in the same commit: CONTEXT.md (Parts needed /
  Need to Order), docs/logic-map.md (graph preamble + the Parts-needed
  edge — which was also stale, missing the ticket-30 → Awaiting repair
  edge — intake route, receive route, demand machine, batchparts demand
  machine, cross-domain matrix incl. a new purchaseorders→batches row),
  docs/data-model.md (demand_records invariants), docs/manual.md (three
  passages that said "a person must move it").
- Full suite 620/620 green; `npm run typecheck` clean.
