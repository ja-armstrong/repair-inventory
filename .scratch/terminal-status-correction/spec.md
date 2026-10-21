# Spec: Terminal statuses are correctable (accident exits)

A device can be set to a terminal Repair Status BY ACCIDENT (a wrong click
on the device grid), and today there is no way back — the status is
absorbing. There must be a way to fix it.

## Requirement

Every terminal status carries graph exits, usable by ANY user through the
same status endpoint (the graph is the arbiter; the exit is evented like any
transition):

- **Repaired** → In progress | QA
- **Unrepairable** → In progress | QA
- **Additional issues present** → In progress | QA
- **Denied Repair** → Awaiting repair (back to the pre-decision state; still
  NO graph edge reaches Denied Repair — it stays rejection-only)

## What "terminal" still means

The statuses remain TERMINAL for every existing purpose:

- **Close eligibility unchanged**: a device sitting in a terminal status
  satisfies the close guard; a device that has been corrected OUT of one is
  non-terminal again and blocks closing until a terminal status is reached
  once more.
- Parts stay frozen on terminal devices (batchparts' terminalResponse); the
  close-time settlement, device-removal refusal, and approval-decision rules
  are untouched.

## What an exit does NOT undo

The exit corrects the STATUS, not the status's side effects:

- Leaving **Additional issues present** does not undo the retriage — the
  continuation row (with the moved parts) still exists on the new batch; the
  accidental continuation is removed separately through the normal
  device-removal flow (its parts return to stock there).
- Leaving **Denied Repair** does not re-reserve the parts returned to stock
  at the denial — they are re-added through the normal part flow (on the
  Open batch, the usual Price Add Limit / manager-amendment rules apply).

The timeline tells the whole story; nothing is silently reversed.

## Non-goals

- No per-edge permissions: the status endpoint's any-user contract is kept
  (the manager's visibility is the timeline; the part flows keep their own
  gates).
- No auto-detection of "accidental" sets — the correction is always manual.
