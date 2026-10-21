# 01 — Approve all devices (bulk) button on an Awaiting-approval batch

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/approve-all-devices/spec.md`.

## Comments

### 2026-10-01 — implemented

- **Server** (`server/domains/batches/lifecycle.ts`): new
  `approveAllDevices` beside `decideDeviceApproval` — the ONE place the bulk
  rule lives. Manager-only callers; Awaiting-approval-only; selects every
  non-removed device with `approval_decision IS NULL`; 409 when none remain
  (no silent success); defensive 409 naming any undecided terminal device
  (unreachable through the UI today, but an inconsistency must never pass
  silently). One transaction sets `approval_decision = 'approved'`,
  clears the note, and records the standard `device.approval_decided` event
  per device with `via: "approve_all"`.
- **HTTP edge** (`server/domains/batches/devices.ts`):
  `POST /api/batches/:batchId/devices/approve-all` behind `requireManager`,
  same parse-defensively shape as the other middleware routes.
- **Web** (`web/src/pages/BatchDetailPage.tsx`): "Approve all devices (N
  undecided)" button in the Approval section — the top of the page while the
  batch is Awaiting approval — shown only to managers while devices are
  undecided, above the existing "Apply limit to undecided" form. Success
  notice reminds the manager to review and then use **Approve batch**.
- **Tests** (`server/tests/device-approval.test.ts`, new describe block,
  5 tests): tech refused (403); only undecided devices decided — earlier
  approvals and rejections (with note) untouched, events recorded with
  `via: "approve_all"`; 409 when nothing is undecided; 409 once the batch is
  Open; full flow — bulk approve-all then Approve batch opens the batch with
  the cost covering every device. All 15 tests in the file pass; server and
  web `tsc --noEmit` clean.
- **Standing docs updated in the same change**: `docs/logic-map.md` (new
  route row), `docs/data-model.md` (`approval_decision` writer list),
  `docs/manual.md` (Approval section mentions the new button).
