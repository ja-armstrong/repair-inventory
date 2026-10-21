# 01 — Exits from terminal Repair Statuses (accident correction)

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/terminal-status-correction/spec.md`.

## Comments

### 2026-10-01 — follow-up: putting a phone down

- Added two more graph edges (same any-user, evented shape): **In progress →
  Awaiting repair** and **Repaired → Awaiting repair** — a tech who puts a
  phone back on the shelf (or recorded Repaired in error) rewinds the work
  state. Parts stay attached and Reserved; only the status moves.
- Tests: new "a tech can put a phone down" test (both edges, attached part
  stays Reserved); the Repaired `allowedNextStatuses` assertion updated to
  `["Awaiting repair", "In progress", "QA"]`; the non-exit refusal example
  switched to Repaired → Unrepairable.
- Docs: logic-map graph lines + a "putting a phone down" bullet; manual
  "Putting a phone down" paragraph; data-model invariant bullet now names the
  Awaiting-repair exits.
- Note: QA → Awaiting repair was NOT added (not requested); a QA device
  still moves via In progress first.

### 2026-10-01 — implemented

- **Graph** (`server/domains/batches/statuses.ts`): `ALLOWED_TRANSITIONS`
  gains exits from every terminal status — Repaired / Unrepairable /
  Additional issues present → In progress | QA; Denied Repair → Awaiting
  repair. `transitionError` now decides from the graph itself (the terminal
  wording fires only for a status with no edges — none today, but the
  message stays for future vocabulary). `TERMINAL_STATUSES` is UNCHANGED:
  it still gates close eligibility, freezes parts on terminal devices
  (batchparts' terminalResponse), and refuses device removal / approval
  decisions on terminal rows. "Terminal" now means close-eligible, not
  absorbing.
- **UI**: no change needed — the device grid renders from the
  server-serialized `allowedNextStatuses`, so the exits appear (and the
  old "(terminal)" label disappears from corrected devices) automatically.
- **Tests**:
  - `batches.test.ts`: the old "forbids leaving a terminal status" test is
    REWRITTEN as "a terminal status can be LEFT" — exits offered via
    `allowedNextStatuses`, Repaired → QA works, non-exit targets still 409
    ("cannot move from Repaired to Awaiting repair"), the correction is
    evented from → to. New tests: every terminal status has an exit back to
    real work (Unrepairable → In progress; Additional issues → In progress
    with the retriage NOT undone — the continuation row keeps the moved
    part); leaving Denied Repair → Awaiting repair on a fresh batch (the
    denial's part return is NOT undone; the kept device's part stays
    reserved). The obsolete "treats Additional issues present as terminal"
    test (which asserted the no-way-back 409) is removed — its setting-side
    behavior is covered by the retriage tests in batchlifecycle.test.ts.
  - `batchlifecycle.test.ts` (close interplay, per review): a device
    corrected out of Repaired blocks close again ("not yet terminal") until
    the repair is re-recorded; closing then succeeds and the parts settle
    exactly as without the detour.
  - `device-approval.test.ts`: the Denied Repair device's
    `allowedNextStatuses` assertion updated `[]` → `["Awaiting repair"]`.
- **Standing docs updated in the same change**: `docs/logic-map.md` (status
  graph exits + the "terminal is not a trap" rule with the two side-effect
  caveats), `docs/data-model.md` (terminal = close-eligible, not absorbing —
  new invariant bullet), `docs/manual.md` ("Fixing a mistake" paragraph: the
  way-back moves, and the two things they do not undo). CONTEXT.md needed no
  edit — "terminal" there describes the run ending, which still holds.
- **Verification**: full suite 456/456; server and web `tsc --noEmit` clean.
