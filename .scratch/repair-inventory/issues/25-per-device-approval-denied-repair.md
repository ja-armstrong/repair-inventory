# 25: Per-device approval and the Denied Repair terminal status

**What to build:** While a batch is **Awaiting approval**, the manager decides each device individually — approved or rejected. Approving the batch then opens it with those decisions applied:

- **Per-device decision**: manager-only, while the batch is Awaiting approval — `POST /api/batches/:id/devices/:id/approval {decision: "approved" | "rejected", note?}` with a `device.approval_decided` event; re-toggling before batch approval is allowed (the latest decision wins).
- **Batch approval requires every device decided**: approving with undecided devices is refused loudly, naming them. No silent default — authorization is per-repair, consciously given.
- **On batch approval** (one transaction): each **rejected** device — (a) all its active part attachments are removed with destination **Available** (the parts are unneeded, not damaged; a genuinely damaged part can be removed manually beforehand) with an auto-note naming the denial, (b) its Repair Status becomes the new terminal **Denied Repair** (resolution notes required at denial, like every terminal status), (c) the batch's approved cost total is computed from **approved devices only**. Approved devices move to Awaiting repair as today.
- **Denied Repair** enters the status graph as terminal, reachable **only** through the approval rejection (not settable directly). Cross-batch history treats it like other terminals; a denied device may later appear on a new batch via normal intake/retriage-by-identifier.
- **UI**: batch detail during Awaiting approval — per-device approve/reject toggles with the deciding note, undecided-count on the batch approve button; Denied Repair renders as a terminal status everywhere statuses render.
- **Reports**: the batches-completed report gains a "Denied" device count (data-model/logic-map/manual updated accordingly).
- Devices added to an already-Open batch keep today's behavior (no per-device approval phase).

**Blocked by:** 23 (the approved-cost computation must use the effective-price snapshots that ticket lands).

**Status:** ready-for-human

- [x] Per-device decision endpoint: manager-only, Awaiting-approval-only, evented, re-togglable (tests)
- [x] Batch approval refuses undecided devices by name (test); on success: rejected devices → parts returned Available (with events) + Denied Repair + resolution notes required; approved cost from approved devices only (test)
- [x] Denied Repair in the status graph as terminal, approval-only reachable (test: direct setting refused)
- [x] UI: per-device toggles during approval, undecided count, Denied Repair rendering
- [x] Batches-completed report includes the Denied count (test)
- [x] Full suite, typecheck, build green; docs (logic-map, data-model, manual, CONTEXT.md already carries the terms) updated in the same commit

## Comments

**Server.** Migration 0015 (see numbering note below) rebuilds `devices`:
`Denied Repair` had to enter the `repair_status` CHECK, SQLite cannot ALTER a
CHECK, and `devices` is a parent table (device_parts, device_consumables,
demand_records reference it) with foreign keys enforced (connection.ts,
ADR-0001) — so the rebuild is a full FK-preserving cascade: copy devices +
all three children, drop the children first, drop devices, rename the copy
back (SQLite's RENAME rewrites the children's REFERENCES clauses), recreate
every index. New columns `approval_decision` (CHECK approved/rejected,
nullable = undecided) and `approval_decision_note`. No PRAGMA, no FK
disabling; all rows carried over untouched.

- `batches/lifecycle.ts decideDeviceApproval`: manager-only, Awaiting-
  approval-only, re-togglable, `device.approval_decided` event; a rejection
  requires a note (it becomes the Denied Repair resolution notes — a denial
  without a why is exactly what the terminal rule prevents). Route:
  POST /api/batches/:batchId/devices/:deviceId/approval (devices.ts, with
  requireManager).
- `approveBatch` rewritten: refuses undecided devices by name (model +
  best identifier); in one transaction each rejected device gets its active
  attachments returned to stock (new `batchparts/queries.ts
  returnAttachmentsToStock` — guarded reserved→available flip, closed
  attachment with the denial auto-note, `part.removed` +
  `device.part_removed` events with reason `batch_denied`), then
  `repair_status = 'Denied Repair'` + resolution notes + a
  `device.status_changed` event with reason `approval_rejected`; the
  approved total covers approved devices only and the `batch.approved`
  event records `deniedDevices`. The direct status write inside
  approveBatch is the lifecycle module acting as the column's owner — the
  graph deliberately has no edge into Denied Repair, and the bare endpoint
  refuses it.
- `batchApprovedCostCents` now excludes Denied Repair devices — a denied
  device contributes nothing to the approved cost, at sign-off AND at any
  later amendment (otherwise a denied device's recorded consumable usage
  would sneak into amendments).
- Denied Repair: statuses.ts vocabulary + terminal set + count key;
  `setRepairStatus` refuses it from every status (tested).
- Reports: `batchesCompletedReport` gains the denied count, and the
  batches-completed CSV gains the "Denied" column (pinned CSV test
  updated).

**Legacy test helpers.** Five test files approve batches without per-device
decisions; each file's local `approveBatch` helper now runs a tolerant
`decideAll` first (decide every undecided device as approved; skip
already-decided ones so double-approve tests don't re-decide on an Open
batch; silent on refusals — the tests assert refusals at the approve call,
where they always happened). Dedicated behavior lives in
`server/tests/device-approval.test.ts` (10 tests).

**UI (BatchDetailPage).** During Awaiting approval a manager sees an
Approval column: current decision (undecided / approved / rejected + its
note), Approve, and Reject with a required inline note. The batch approve
button shows "(N undecided)" and is disabled while N > 0 — the server's
by-name refusal remains the authority. Denied Repair renders as a terminal
status everywhere statuses render (batch counts on BatchesPage and
BatchDetailPage, "(terminal)" in StatusControl, close-section copy).

**Migration numbering (again).** The plan said 0016 "since 0015 was ticket
23's" — but on disk ticket 23 landed as 0014 (its ticket text said 0015
based on a stale belief about ticket 22; see that file's header). 0015 was
the next free number and is what this migration took; nothing renumbered.

**Full suite 371/371, typecheck and build green.** Docs updated in the same
commit: logic-map (routes, both state machines, cross-domain matrix,
reports), data-model (0015 entry, devices columns + invariants), manual
(approval section, status list, close copy, report description,
who-can-do-what).
