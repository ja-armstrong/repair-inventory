# 06: Batch approval, close, and retriage

**What to build:** The batch lifecycle on top of parts-on-batches. A batch in Awaiting approval becomes Open when a manager approves (cost sign-off — the approval event records the approved total). After approval, techs can only perform same-SKU swaps on device part lists; any other part change (add, remove, different-SKU) is refused for techs, allowed for managers in place (event + required note, approval stands amended). Closing a batch requires every device to be terminal (Repaired, Unrepairable, or Additional issues present); at close, installed parts become Unavailable and uninstalled reserved parts return to Available. Retriage: marking a device "Additional issues present" ends its run on the batch, carries its reserved parts over, and stages it for a new batch (matched by identifiers for cross-batch history).

**Blocked by:** 05 (parts on batches).

**Status:** ready-for-human

- [x] Manager approval moves Awaiting approval → Open and records the approved cost total; techs cannot approve
- [x] Post-approval part-list changes: same-SKU swaps only for techs (enforced server-side); managers can add/remove/change SKUs in place with a required note; violations are rejected with a clear message
- [x] Close is blocked while any device is non-terminal; on close, installed parts → Unavailable, uninstalled reserved parts → Available, all via recorded events
- [x] "Additional issues present" on a device with reserved parts carries them over to the new batch context (still Reserved, linked to the new device row), and the device's history links across batches by identifier
- [x] Retriaged devices appear on the new batch with their parts requiring fresh approval
- [x] Batch UI: approve action for managers, close action with guard messaging, retriage flow, cross-batch device history view
- [x] API tests cover the approval gate, post-approval restrictions per role, close guard and part settlement, and the retriage carry-over

## Comments

Implementation (13 tests in `server/tests/batchlifecycle.test.ts`; full suite 215/215, typecheck + build green).

**Endpoints** (all under the session-gated `/api` router):

- `POST /api/batches/:id/approve` — manager-only (`requireManager`). Body `{ note }` (required). Guards: 404 unknown batch, 400 blank note, 409 when not Awaiting approval. Awaiting approval → Open; stores `approved_at/by/cost_cents` and records `batch.approved` with the computed Parts Cost total (snapshotted reservation prices, so the approved number cannot drift).
- `POST /api/batches/:id/close` — any user. Guards: 409 Awaiting approval (approve first), 409 already Closed, 409 empty batch ("a batch with no devices cannot be closed" — an explicit decision: close means done), 409 naming every non-terminal status with counts. On close: each installed part flips Reserved → Unavailable via a guarded `UPDATE … WHERE status='reserved'` + a `part.status_changed` event (reason `batch_closed`), then `batch.closed` records the settled list — and, loudly, any active attachment whose part was already not Reserved (e.g. an audit close got there first), where nothing was written.
- `POST /api/batches/:id/devices/:deviceId/status` — unchanged shape; setting "Additional issues present" now ALSO performs the retriage in the same transaction and the response carries `retriagedTo: {batchId, batchNumber, deviceId}`.
- `GET /api/batches/:id/devices/:deviceId/history` — cross-batch device history: other device rows matched by shared IMEI / Asset ID / serial number, plus the retriage chain (`prior_device_id`), each serialized with `batchNumber`, `repairStatus`, `priorDeviceId`.
- Existing part endpoints gate on the lifecycle: add/remove/consumable are 403 for techs on an approved batch (swap always allowed); manager add/remove/consumable on an Open batch require a note and record `batch.approval_amended` (old→new approved totals) and update `approved_cost_cents` in the same transaction. Part changes on terminal devices remain 409.
- Device detail/summary responses now carry `status`, `approvedAt/By/Cost`, `closedAt/By`, per-device `allowedNextStatuses` (server graph narrowed by lifecycle), `priorDeviceId`, `batchNumber`, and viewer-scoped `partEditPermissions` — the client renders from these instead of re-encoding the rules (architecture review finding G folded in).

**Lifecycle state machine as implemented** (migration `0010-batch-lifecycle.sql`, stored `batches.status`; device Repair Statuses stay graph-checked in `batches/statuses.ts`):

- `Awaiting approval → Open`: manager approval only; approval gates the repair PROCEEDING, not the stock reservation — pre-approval techs edit part lists freely and a device may sit in "Parts needed", but `setRepairStatus` refuses every other transition with a clear message.
- `Open → Closed`: any user, every device terminal; installed parts → Unavailable.
- "Uninstalled reserved parts → Available at close" has no population in this schema: a part is Reserved only through an active `device_parts` attachment, and removals already chose a destination at removal time — the close settlement therefore covers the batch's active attachments (documented in `lifecycle.ts`).

**Retriage carry-over mechanics:** reaching "Additional issues present" (only from In progress/QA, with required resolution notes) atomically creates a NEW batch (Awaiting approval — fresh approval required) and a new device row copying model/identifiers/stated issue (fresh Triage Date, `prior_device_id` link), moves the active attachments (parts stay Reserved at their snapshotted prices) and the open Need to Order demands onto the new row, and records `device.retriaged` (old row), `device.retriaged_in` (new row), and a `part.transferred` event per carried part. The old batch can then close normally; the carried parts on the new batch are untouched by the old batch's close.

**Finding D (architecture review):** closed. `batches/lifecycle.ts:setRepairStatus` is the only writer of `devices.repair_status` — graph-checked, approval-gated, event-recording, transaction-composable. The batches status endpoint and batchparts' demand auto-move both call it; the direct `UPDATE devices SET repair_status='Parts needed'` is gone from batchparts.

**S4 (code review):** closed. `getBatchNumber` throws on a missing batch row instead of fabricating number 0 into immutable timeline payloads (batchparts endpoints now mostly take the number from the already-joined device row; receiving keeps the helper).

**Deviations / known seams (deliberate, not oversights):**

- Manager part changes require a note post-approval (the ticket says the approval stands amended — the note is the amendment's record). Approval itself also requires a note, matching ticket 07's PO approval.
- Consumable usage counts as a part change for the approval gate (it moves Parts Cost — spec story 37): post-approval, techs cannot record it, managers record it with a note.
- Empty batches cannot be closed (see above); devices cannot be added to a Closed batch.
- Known cross-ticket seam, recorded for the orchestrator: ticket 08's PO receipt auto-reserves a received part onto the demanding device even when that batch is already Open — the part arrives without an approval amendment. Follows ticket 08's landed behavior; a receipt-time amendment (or a note rule) is a decision for a follow-up ticket if wanted.
- Swaps re-snapshot the SKU's CURRENT catalog price onto the new attachment (ticket 05 semantics, unchanged); a catalog price change between reservation and swap can therefore move a device's cost without an amendment. Same-SKU swaps are cost-neutral whenever the catalog price is unchanged.
- Existing batches in a pre-0010 database come up as Awaiting approval and need a one-time approval.
