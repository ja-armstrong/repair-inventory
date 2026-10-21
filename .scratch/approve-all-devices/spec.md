# Spec: Approve all devices (bulk)

A manager reviewing a batch in **Awaiting approval** decides each device
individually (ticket 25). With many devices, deciding them one by one is
tedious when the answer is the same for all of them.

## Requirement

Add an **Approve all devices** button to the top of a batch in Awaiting
approval (the Approval section of the batch page, manager-only):

- It approves every device that has **no decision yet** — one request, one
  transaction.
- Devices already decided are never touched: an earlier **rejection keeps
  its note** and its Denied Repair fate at batch approval (silently flipping
  a rejection would be a silent fallback).
- Every device decided by the bulk action records the standard
  `device.approval_decided` event, so the timeline reads the same as
  decisions made one at a time.
- Manager-only; Awaiting-approval-only; loud 409 when there is nothing left
  to decide.
- The batch still requires the manager's **Approve batch** sign-off (note
  required) after the bulk decision — the button only clears the undecided
  devices, it does not open the batch.

## Non-goals

- No bulk reject: a rejection requires a per-device note, so it cannot be
  applied blindly to many devices.
- No Price Add Limit handling: the existing "Apply limit to undecided"
  form already covers limits; the bulk approve leaves each device's limit
  (default $0) untouched.
