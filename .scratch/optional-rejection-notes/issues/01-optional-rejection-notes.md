# 01 — Rejection notes are optional

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/optional-rejection-notes/spec.md`.

## Comments

### 2026-10-02 — implemented

- **Server** (`server/domains/batches/lifecycle.ts`): `decideDeviceApproval`
  no longer refuses a noteless rejection — the note-required 400 is gone.
  `approveBatch`'s denial write now omits `resolutionNotes` from the
  `device.status_changed` event payload when the manager gave none (the
  column was already nullable); with a note, everything is exactly as
  before.
- **Web** (`web/src/pages/BatchDetailPage.tsx`): the Reject button is no
  longer disabled by an empty note; the input reads "rejection note
  (optional)".
- **Tests** (`server/tests/device-approval.test.ts`): the old
  "rejecting requires a note" test is REWRITTEN — a noteless rejection is
  accepted (decision recorded, note null), and a note given later (re-decide)
  still lands as the denial's resolution notes. New test: a noteless
  rejection flows through batch approval — Denied Repair, NULL resolution
  notes, `approval_rejected` status event on the timeline, part returned to
  stock. Full file 16/16.
- **Standing docs updated in the same change**: `docs/logic-map.md`
  (approval route row), `docs/data-model.md` (`approval_decision_note` and
  the `resolution_notes` exception), `docs/manual.md` (Approval section).
  `CONTEXT.md` never stated the note requirement — no change.
- **Verification**: full suite 466/466; server and web `tsc --noEmit` clean.
