# Spec: Fulfillment auto-unblocks the device

When a device's Need to Order demand record is fulfilled, the device's
Repair Status moves by itself from **Parts needed** to **Awaiting repair** —
no human status change required.

## Contract

- The move happens at FULFILLMENT (the guarded `open → fulfilled` flip),
  not at reservation: a refused reservation (Closed batch) leaves the
  demand open and the device blocked.
- Only a device currently in **Parts needed** moves. A tech who pulled the
  device back to work while waiting (In progress) is not rewound by an
  arrival.
- Only the device's LAST open need unblocks it: while other open demand
  records remain for the device, it stays in Parts needed (the same rule
  the status endpoint's unblock enforces).
- The move goes through `setRepairStatus` (the one writer of
  `devices.repair_status`) — graph-checked and event-recorded
  (`device.status_changed`, reason `need fulfilled`). The
  Parts needed → Awaiting repair edge already exists in the graph and is
  allowed even on an Awaiting-approval batch (the ticket-30 unblock).
- Both arrival doors take the rule from one place:
  `batches/lifecycle.ts autoUnblockAfterDemandFulfilled`, called by
  `purchaseorders/receiving.ts` (PO receipt) and `parts/intake.ts`
  (salvage/migration intake) right after their fulfillment flip.
- A demand with no device fulfills as today — nothing to move.

## Docs

Standing docs updated in the same commit: CONTEXT.md (Parts needed /
Need to Order), docs/logic-map.md (status graph line, intake + receive
routes, demand state machine, cross-domain matrix), docs/data-model.md
(repair_status writer / demand_records invariants), docs/manual.md (the
"the app does not do that step" passages).
