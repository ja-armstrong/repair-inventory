# 01 — Reject clickable on an approved device

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/reject-after-approve/spec.md`.

## Comments

### 2026-10-02 — implemented

- **Web** (`web/src/pages/BatchDetailPage.tsx`, ApprovalControl): the Reject
  button's disabled condition was `busy || decision === "approved"` — copied
  from the Approve button, it locked BOTH decisions once a device was
  approved, contradicting the server's re-decide-until-open rule. Now each
  button locks only on its own current decision: Approve on `approved`,
  Reject on `rejected`. A comment on the button records the why.
- No server change: `decideDeviceApproval` already accepts either decision
  until the batch opens (pinned by the "re-togglable — the latest decision
  wins" test), and refuses after it does (409; the column is hidden then
  anyway via `canDecideApproval`).
- **Verification**: web `tsc --noEmit` clean; full suite 467/467 (no UI test
  harness for the page — the server-side rule was already pinned).
