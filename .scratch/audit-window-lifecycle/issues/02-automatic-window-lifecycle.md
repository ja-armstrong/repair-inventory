# 02 — Automatic window lifecycle: lazy boundary processing

Status: ready-for-human

## Problem

Windows open only when a user remembers, and close only when a user chooses. The shrink signal must not depend on anyone remembering: the window opens itself on the interval boundary and the next boundary closes it (ADR 0002).

## What to build

- **Lazy boundary processing**: any authenticated audit-domain request (the status route the banner polls every 60s is the natural trigger) checks "is a boundary past?" and, if so, performs the transition inline. No background jobs.
- **Auto-close**: an open window is closed with the unchanged no-grace settlement (due-but-unscanned → Unavailable through the existing `changePartStatus` `via: "audit_close"` and Reserved-attachment settlement seams). `closed_by` is NULL and a system timeline event records "auto-closed at interval".
- **Computed close kind** (new `close_kind` on the audit, stamped at close): nothing due-and-non-exempt left → `complete`; anything left → `shortfall`. Computed for manager closes too — the kind is never declared. No note is required on either kind. Backfill `close_kind` for already-closed audits by computing from their buckets.
- **Auto-open**: the next window opens from the same boundary, `scheduled_at` = that boundary; `anchor_at` stays the end-of-UTC-day of the previous audit's actual `opened_at` (the counting session that matters for "counted since last time"). Exactly-one-open is preserved.
- **Collapse rule**: if multiple boundaries passed in silence, settle the old window once, dated at the latest missed boundary, and open the new window from it. Skipped windows never exist; the timeline records the gap.
- **Bootstrap-only manual open**: the open route is refused unless no audit has ever existed, and then only for a manager. From the second window on, opening is automatic — `(scheduled_at NULL)` audits can only ever be the bootstrap.
- Scanning and status routes are untouched.

## Blocked by

01 (schedule-anchor swap).

## Acceptance

- [ ] Fake clock past a boundary + status request: open window auto-closes (correct kind from buckets, `closed_by` NULL, system event) and the next window opens with `scheduled_at` = that boundary.
- [ ] Manager close before the boundary stamps the manager and computes the kind; a close with remaining due parts records `shortfall` even if the manager believed it clean.
- [ ] Two missed boundaries: exactly one settlement, dated at the latest boundary; one new window; no phantom audits.
- [ ] Open route: 403 for a tech, 409 for a manager once any audit exists; succeeds only for a manager on a virgin system.
- [ ] No note required on close; settlement behavior identical to today's (existing settlement tests pass unchanged).

## Doc obligations

- `docs/logic-map.md`: audits state machine (auto-close at boundary, bootstrap-only open), route table (open/close semantics), the lazy-mechanism note.
- `docs/data-model.md`: `close_kind` column and invariant; `closed_by` NULL means auto-close.
- `docs/manual.md` §9: window opens by itself, closes by manager or at the next boundary.

## Comments

- Origin: grilling session 2026-10-05 (`.scratch/audit-window-lifecycle/spec.md` decisions 1–5, 7–9; ADR 0002). User's framing: "an audit window should always be open… it may be closed early by a manager; either because everything that must be audited has been scanned or because of some shortfall." The gap after an early close is intended — the next window opens on schedule, not on close.

## Comments (ticket 02 implementation)

**What was built** — the automatic window lifecycle (ADR-0002), implemented as one core module plus route wiring:

- `server/domains/audits/lifecycle.ts` (new): the ONE writer of `audits` rows and `audit_parts.outcome`, shared by the HTTP routes and the lazy processor — `openAuditWindow` (due-list snapshot + `audit.opened` event), `closeAuditWindow` (unchanged no-grace settlement: `changePartStatus` `via: "audit_close"` + the Reserved-attachment seam via `settleAttachmentForAuditFailure`; stamps `closed_at`/`closed_by`/`close_kind` + the `audit.closed` event), `computedCloseKind` (`failed > 0 → shortfall`, else `complete` — computed, never declared), `latestMissedBoundary` (calendar-month iteration with a loud 1200-boundary guard), and `processDueBoundaries` (the lazy check: anchor = last audit's `scheduled_at` ?? `opened_at`; auto-close + auto-open in ONE transaction so exactly-one-open survives the transition). The audit row/`AUDIT_SELECT`/`snapshotRows` helpers moved here from `index.ts` so close and the serializers read one shape.
- `server/domains/audits/index.ts`: a router-level middleware runs `processDueBoundaries` before every `/api/audits` route and before `/api/cycle-counts` (the ticket's "any authenticated audit-domain request"; the banner's 60s status poll is the natural trigger). The open route is now `requireManager` + bootstrap-only (403 tech / 409 once any audit exists; the bootstrap window keeps `scheduled_at` NULL). The close route delegates to the close core. Detail/list payloads expose `closeKind`.
- `server/db/migrations/0026-audit-close-kind.sql`: adds nullable `audits.close_kind` (CHECK vocabulary domain-guaranteed — SQLite cannot ALTER a CHECK) and backfills every closed audit from its buckets (`EXISTS(failed outcome) → shortfall`); open windows stay NULL.

**Tests** — `server/tests/audits.test.ts`: new "automatic window lifecycle (ticket 02)" block covering all five acceptance criteria (auto-close+auto-open at a boundary via the status request with `closed_by` NULL and the actor-less system event; auto-close `complete`; lazy transition on a non-status route; two-missed-boundaries collapse — one settlement, one new window, no phantom audits, next boundary from the LATEST missed one; early-close gap; computed kind both ways with no note; bootstrap gating 403/409) and a new migration-0026 backfill test. Existing tests reworked ONLY where the lifecycle replaces a manual second open: the worked example's 2nd/3rd windows now arrive via the status request's auto-open (same instants, same due-ness assertions); the two ticket-01 "transitional manual re-anchor" tests became refusal tests (the refusal is what makes the drift-free anchor permanent); the banner's boundary-instant case now reads "open" (the same request opens the window); the tech-open test became a gating test. Settlement tests (ticket 14's Reserved-attachment settlement, exemptions, scan-wins) pass UNCHANGED. Also re-pointed `intake.test.ts` and `buybacks.test.ts` audit opens at the manager (they opened as techs) and made intake's second window a boundary auto-open. Full suite: 540 passed; `npm run typecheck` clean.

**Decisions made** (spec/ADR-0002 were silent or ambiguous):

1. **`closed_at` on an auto-close is the request instant, not the boundary** — ADR-0002's consequence ("timestamps are accurate to the first request after a boundary, not the boundary instant") is taken literally; the acceptance criterion's "settlement dated at the latest boundary" is read as WHICH boundary the transition is attributed to (the new window's `scheduled_at` and the auto-close event's `boundary` field), not a backdated `closed_at`. Backdating would also contradict the part-status events, which are stamped now.
2. **Two attributions on an auto-close** — the audit's `closed_by` is NULL and its `audit.closed` event is actor-less (`auto: true`, `reason: "interval"`, `boundary`, `missedBoundaryCount` — the timeline's gap record), but the part-level settlement events (`part.status_changed`, attachment settlement) name the user whose request triggered the transition: there is no system user to attribute a guarded status flip to, and `changePartStatus` requires an actor. The auto story lives on the audit's own timeline.
3. **The auto-opened window's `opened_by`** is the triggering request's user (the column is NOT NULL with no system user); the event payload's `scheduledAt` (= the boundary) is what marks it automatic.
4. **A close request that arrives after its window was just auto-closed 409s** ("already closed") — the middleware transition happens first, so no route sees a stale lifecycle; a manager clicking Close a moment too late is told the window closed itself.
5. **The boundary-instant edge (`now == boundary`) counts as past** (`>=`), matching the banner's `until <= 0` "due" semantics; the worked example's second window opens at exactly 03.01T12:00 as before.
6. **`close_kind` added to list/detail payloads** as `closeKind` (the ticket pins the data, the UI shows it in ticket 04).

**Doc obligations** — `docs/logic-map.md` (audits intro + lazy-mechanism note, route table open/close semantics, window state machine with the collapse rule), `docs/data-model.md` (0026 in the migration list; `close_kind` column + computed invariant; `closed_by` NULL means auto-close; tail invariant 8 extended), `docs/manual.md` §9 (window opens by itself; closes by manager or at the next boundary; computed complete/shortfall; the collapse rule). `README.md` untouched (no run-instruction change); `CONTEXT.md`'s Audit entry was already rewritten at grilling.
