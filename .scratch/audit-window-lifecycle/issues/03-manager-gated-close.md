# 03 — Manager-gated close

Status: ready-for-human

## Problem

Closing a window — accepting the shrink or certifying the count complete — is a judgment call, but today any logged-in user can close. Both of the manager's close reasons (everything scanned, or accepting a shortfall) belong behind the same gate.

## What to build

- The close route requires manager powers (`requireManager`); techs get 403. Admin passes, as everywhere, through the single manager-powers predicate — no direct admin branching.
- Scanning into the open window and reading status stay open to any authenticated user.
- The close itself is unchanged otherwise: the close kind is computed from the buckets (ticket 02), no note required, settlement unchanged. The closing manager is stamped `closed_by` as today.

## Blocked by

None (can start immediately). It touches the same route as ticket 02, so landing it after 02 avoids touching the close route twice — but nothing gates on it.

## Acceptance

- [ ] Tech closing an open window gets 403; manager and admin close normally.
- [ ] Scan and status routes still work for techs.
- [ ] Tests cover the 403 and the unchanged close behavior for managers.

## Doc obligations

- `docs/manual.md`: permission matrix — close audits becomes manager-only (open/scan rows unaffected).
- `docs/logic-map.md`: audits route table gains the manager gate on close.

## Comments

- Origin: grilling session 2026-10-05 (`.scratch/audit-window-lifecycle/spec.md` decision 6). User: close "may be closed early by a manager; either because everything that must be audited has been scanned or because of some shortfall" — both reasons, one gate.

- `server/domains/audits/index.ts`: `POST /api/audits/:id/close` now composes `requireManager` ahead of the handler — techs get 403, and admin passes through the same single manager-powers predicate as every other manager-only route (no admin branching). Inline comment records WHY: closing is the manager's judgment call; scan/status stay any-authenticated-user so a tech can work the window alone. The close body is otherwise untouched — computed close kind (ticket 02), no note required, unchanged settlement, `closed_by` stamped with the closer.
- One mechanical knock-on: with a middleware ahead of the handler, Express loses the path-typed `req.params`, so `parseId` widened to `string | string[] | undefined` — the same widening `parsePoId` already carries in the purchaseorders domain.
- Auto-close untouched by design: the lazy boundary processor (`processDueBoundaries`) is not a route and settles windows regardless of who triggers the request; `requireManager` gates only the HTTP close. Noted on the logic-map close row so no future reader "fixes" the processor into the gate.
- Tests (`server/tests/audits.test.ts`): new describe block "manager-gated close (ticket 03)" — tech 403 with the window verified untouched and still open; admin and manager both close normally (computed shortfall/complete, `closed_by` stamped); tech scan + status + detail still 200, and the tech's scan feeds a later manager close. The pre-existing "techs scan and close but cannot open" test was retitled and reworked: tech close attempts now expect 403 — including on a nonexistent audit, where the gate runs before the lookup (a manager still gets the 404) — and the manager performs the closes.
- Tests (`server/tests/intake.test.ts`): the two setups that had a tech close a window now close as the manager; the tech only does the intake work under test.
- Docs: `docs/logic-map.md` audits route table — close row gate changed to `manager` with the predicate/stamp note; `docs/manual.md` permission matrix — "scan into an open audit window; cycle count" stays Yes/Yes, "close an audit window (early, by hand)" becomes No/Yes; §9 Closing section states the gate in plain words. Open/scan rows unaffected.
- Both gates green: `npm run typecheck` passes, `npm test` passes (27 files, 543 tests).
