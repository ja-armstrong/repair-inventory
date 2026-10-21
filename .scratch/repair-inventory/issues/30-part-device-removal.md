# 30: Part and device removal while blocked on Need to Order

**What to build:** On batches waiting on Need to Order — before approval or
after — techs may remove parts from devices, and devices may be removed from
their batch entirely.

**Status:** ready-for-agent→done (awaiting review sign-off)

- [x] Post-approval (Open batch) part removal passes for ANY tech when the
      device sits in **Parts needed**; destination + note as always; the
      standing approval is AMENDED by the acting tech. Other devices remain
      manager-gated (403 names the device's status, Parts needed, and the
      options)
- [x] `POST /api/batches/:batchId/devices/:deviceId/remove` `{note}` — any
      tech, while the batch is Awaiting approval or Open; refuses terminal
      devices and Closed batches
- [x] Device removal, one transaction: active attachments → Available via the
      denial's shared `returnAttachmentsToStock` (reason `device_removed`);
      OPEN demand → cancelled (`demand_records.status` CHECK extended,
      `cancelled_at/by` recorded, guarded flip); row soft-removed
      (`removed_at/by/note`); Open batch → approval amended (total excludes
      the device)
- [x] Live-listing exclusivity: batch detail, device counts, batch parts,
      approval decisions, close blocking, search, and the status endpoint all
      ignore removed devices; history endpoints (cross-batch matching, part
      attachment history) and the events timeline still see the row
- [x] Only OPEN demand may be marked ordered (`demandExists` tightened);
      receipt (`pickDemand`, already `status='open'`) never auto-reserves a
      received unit onto a removed device
- [x] Web: per-row Remove action on the batch grid (confirm + required note,
      rendered only on non-terminal devices of unclosed batches); Timeline
      descriptions for `device.removed`, `device.demand_cancelled`,
      `demand.cancelled`; batch-level `partEditPermissions.removePart` now
      always offered — the per-request gate is the server's (same
      offer-and-refuse shape as addPart)
- [x] Follow-up (user): cancelling a Need to Order record itself —
      `POST .../devices/:deviceId/demand/:demandId/cancel` `{note}` (any
      tech, pre- or post-approval, never on a Closed batch; the demand is an
      estimate so no approval amendment); a "Cancel need to order" action on
      each demand line in the parts panel; and the graph's unblock exit
      **Parts needed → Awaiting repair** (refused while any open demand
      remains, pre-approval included) so "Parts needed" is never a trap
- [x] Follow-up (user): per-batch device numbers — stable "device #8"
      (migration 0020: `devices.device_number`, backfilled by creation
      order, partial UNIQUE (batch_id, number); MAX+1 at insert in both
      writers — add and retriage; removed devices never reissue theirs);
      shown as the grid's first column and in the parts/history modal titles
- [x] Follow-up (user): parts panel, edit device, and add device live behind
      a shared Modal (Esc / backdrop / × close); the "Remove from this
      batch" action moved inside the edit-device modal as a confirm step
- [x] API tests: `server/tests/device-removal.test.ts` (18) — gate passes /
      refusals, amend by tech, full removal effects, approval/close
      exclusion, PO cancelled-demand refusals, search exclusion, history
      preserved, demand cancellation + unblock gate, device numbering
      (stable, per-batch, retriage restarts); full suite 442 green

## Comments

Implemented in `server/db/migrations/0019-device-removal.sql` (devices soft-
remove columns; demand_records rebuilt for `'cancelled'` + cancelled_at/by —
standalone rebuild, purchase_order_demand carries no FK to it),
`batches/lifecycle.ts removeDeviceFromBatch` (the one writer of device
removal; composes batchparts' `returnAttachmentsToStock` + `cancelDemand`),
`batchparts/index.ts partEditRefusal/amendIfApproved` (Parts-needed gate;
Open-batch removals amend regardless of role), `batches/devices.ts` route,
and removed-device filters across serialize/queries/search.

**Decisions worth review:**
- Soft removal keeps device ids meaningful in immutable timeline events and
  cross-batch identifier matching (CONTEXT.md: Device) — nothing rewrites
  history.
- The batch-removal note doubles as the return-to-stock note on each part and
  the cancellation note on each demand — one "why", recorded everywhere it is
  needed, no second dialog.
- Already-ordered demand cancelled mid-PO keeps its purchase_order_demand
  link: the PO genuinely bought the part; receipt now lands it Available.
- `demandExists` now requires `status='open'` (was: any status) — fulfilled
  demand could previously be marked ordered again; the tightening makes the
  ticket-30 cancellation rule expressible and is tested.
- Demand cancellation does NOT amend the approval (a Need to Order is an
  estimate at SKU default price, never signed-off cost) and does NOT
  auto-move the device out of Parts needed — the unblock is a human status
  change, which the graph now permits (Parts needed → Awaiting repair, open
  demand must be gone first). Why not auto-move: "Awaiting repair" vs "In
  progress" is where the run came from and the server doesn't store it.
- Device numbers are STORED (stable), not derived ordinals: a derived
  ordinal renumbers on removal and lies about history; batches.number and
  purchase_orders.number set the precedent.

**Pending (deliberately deferred by the user to a later full-doc pass):**
README.md, docs/manual.md (batch + permissions tables), docs/data-model.md
(devices columns, demand_records CHECK, 0019 row), docs/logic-map.md is
PARTIALLY updated (batch routes, lifecycle bullets, demand state machine,
batchparts routes/Demand record) — the cross-domain matrix rows (batches ↔
batchparts writers, purchaseorders demand contract) still describe the old
shape; CONTEXT.md Approval paragraph + a **Device Removal** term.
