# Spec: Rejection notes are optional

Deciding a device `rejected` at batch approval currently REQUIRES a note
(server 400, UI disables the button). The shop wants the note optional: the
rejection itself is the decision; requiring prose for every denial is
friction.

## Requirement

- `decideDeviceApproval` accepts `{ decision: "rejected" }` with no note.
- When a note IS given, it still becomes the Denied Repair resolution notes
  at batch approval (unchanged).
- A noteless rejection still denies fully at approval: device → Denied
  Repair, parts return to stock, and the record is the event pair
  (`device.approval_decided` with decision rejected; the `approval_rejected`
  status change) — the denial is never silent, it just has no free text.
- The web Reject button is no longer disabled by an empty note; the input is
  labeled optional.

## Consequence accepted

A Denied Repair device can have NULL resolution notes — the one deliberate
exception to the terminal-status resolution-notes rule, because Denied
Repair's WHY lives in the recorded rejection event, not only in free text.
