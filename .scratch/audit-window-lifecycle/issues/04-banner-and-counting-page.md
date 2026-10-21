# 04 — Banner + counting page for the automatic lifecycle

Status: ready-for-human

## Problem

The UI still speaks the old language: a due/one-week/two-weeks nag ladder for a window nobody has opened yet, an open button for a lifecycle that opens itself, and labels that distinguish manual from scheduled opens that no longer exist.

## What to build

- **Banner** (`AuditBanner`): while a window is open it shows the live audit and its boundary date — the open window *is* the nag. During the gap (after an early close, before the next scheduled open) it counts down to the next scheduled open. The due/one-week/two-weeks ladder is gone.
- **Close button**: visible to all, enabled only for managers (per ticket 03's gate).
- **Open button**: appears only in the bootstrap state — a manager on a system with no audits — and never again afterwards.
- **Past-audits list**: `(manual)` label only for the bootstrap audit (`scheduled_at` NULL); every other audit shows its scheduled date instead of the `(scheduled)` label.
- Server behavior is untouched; this ticket consumes the payloads tickets 01–03 produced.

## Blocked by

02 (automatic window lifecycle — status payload shape) and 03 (manager-gated close — the button's enabled state).

## Acceptance

- [ ] Open window: banner names the live audit and its boundary; gap: banner counts down to the next scheduled open; the old ladder stages render nowhere.
- [ ] Tech sees the close button disabled; manager sees it enabled; a non-manager never sees an Open button.
- [ ] Bootstrap state: a manager on a virgin system sees Open; after the first audit closes, no Open control exists for anyone.
- [ ] Bootstrap audit renders `(manual)`; all others render their scheduled date.

## Doc obligations

- `docs/manual.md` §9: what the banner and counting page show under the new lifecycle.
- `docs/logic-map.md`: banner stage ladder replaced by the two steady states (open window / gap countdown).

## Comments

- Origin: grilling session 2026-10-05 (`.scratch/audit-window-lifecycle/spec.md` decisions 2 and 10). The banner's 60-second poll is what makes lazy boundary processing timely — it stays.

## Comments (ticket 04 implementation)

**What was built** — the UI now speaks the automatic lifecycle's language (server untouched; this ticket only consumes the ticket 01–03 payloads):

- `web/src/auditBanner.ts` (new): the banner's display logic as a pure, tested module — `bannerState` derives exactly the two steady states from the status payload (`openAuditId` / `lastScheduledAt` / `nextAuditAt`): **open window** (names the live audit and its boundary — `lastScheduledAt` IS the open window's own boundary, because the lifecycle invariant makes an open window always the newest audit; NULL boundary only on the bootstrap window, where the banner says "opened by hand" instead of inventing a date) and **gap** (counts down whole days to the next scheduled open). The bootstrap state (no audits at all) renders nothing deliberately — there is no cadence to nag about. The old due/one-week/two-weeks ladder is not representable in the state vocabulary (exhaustiveness-tested).
- `web/src/components/AuditBanner.tsx`: rewritten to render those two states; the 60-second poll is unchanged (it is what makes the lazy boundary processor timely). The component no longer reads the payload's `banner.stage` field, which the server still emits — noted as unused in the logic-map status row.
- `web/src/auditLabels.ts` (new) + `AuditsPage` past-audits list: `(manual)` only for `scheduled_at` NULL (the bootstrap audit); every other audit shows `— scheduled <date>` instead of the old `(scheduled)` word. Also added a **Result** column showing the computed `closeKind` (`complete` / `shortfall`, `—` while open) — ticket 02's comments deferred "the UI shows it in ticket 04".
- `AuditsPage` close button: visible to everyone, `disabled={busy || !manager}` — the client-side mirror of ticket 03's `requireManager` gate; the server stays the enforcer (a stale client cannot close). A tech sees the disabled button plus a one-line "Closing is a manager's decision" note.
- `AuditsPage` no-window branch split by lifecycle state: **bootstrap** (`status.lastAuditAt === null`) shows the Open form to managers only ("A manager opens the first window." for techs — a non-manager never sees an Open control); **gap** (any audit exists, none open) states the next automatic open and has NO Open control for anyone, manager included — after the first audit exists the route's 409 makes that permanent.

**Decisions made** (the ticket was silent or ambiguous):

1. **The open window's boundary comes from `lastScheduledAt`, not a second request** — ticket 02's status comment says the field exists so ticket 04 can "show the schedule and count down to the next boundary without a second request". The banner therefore derives the open window's boundary from the status payload alone, relying on (and commented on) the lifecycle invariant that an open window is always the newest audit. The one case the payload cannot date is the open bootstrap window (`scheduled_at` NULL); the banner states that fact in words rather than guessing a date.
2. **Manager powers, one predicate** — `AuthUser.role` widened to include `"admin"` (the server's `/api/auth/me` really returns it) and a `hasManagerPowers` predicate added to `web/src/auth.tsx` mirroring the server's single predicate; the close button gates on it, so an admin sees the button enabled exactly when the server would accept the close. Pre-existing `user?.role === "manager"` checks elsewhere (nav items, approvals) were left alone — out of this ticket's scope, but an admin today cannot see those controls; flagged here for a future ticket.
3. **Banner silence in the bootstrap state** — the server's `bannerStage` already returns NULL there; the UI keeps that semantic (nothing to nag about) and the Counting page carries the Open guidance instead.
4. **Countdown days round up** and clamp at 0 only for client/server clock skew — the lazy processor guarantees the boundary is ahead when the payload was built.

**Tests** — `web/src/auditBanner.test.ts` (13) and `web/src/auditLabels.test.ts` (3), following the repo's pure-logic vitest pattern (node environment, no DOM tests): state derivation for all four payload shapes, boundary wording, countdown day math (exact / singular / round-up / far-future — the case where the old ladder was silent), bootstrap silence, an exhaustiveness guard that the ladder stages are not representable, and the label rule both ways. Component wiring (poll, role gating, JSX) is covered by `npm run typecheck`; the server gate itself is ticket 03's tests. Full suite: 29 files, 559 tests passed; `npm run typecheck` clean.

**Doc obligations** — `docs/manual.md` §9: the banner section rewritten to the two steady states (plus the bootstrap silence), and the Opening-the-window section now states the Open control is bootstrap-only and manager-only; the §2 banner mention reworded. `docs/logic-map.md`: the status route row documents that `banner.stage` is now unread legacy, and a new "The banner" note under the audits domain records the two steady states and the counting page's Open/Close gating. `README.md` and `docs/data-model.md` untouched (no run-instruction or schema change).

