# Automatic audit window lifecycle

Status: ready-for-agent
Origin: grilling session 2026-10-05 (user + agent, questions and answers recorded in session). All decisions below are user-confirmed. Decision record: `docs/adr/0002-automatic-audit-window-lifecycle.md`.

## Problem

Audit windows depended on a user remembering to open one and choosing to close one. The cadence only nagged (banner ladder open → due → one-week → two-weeks), every audit re-anchored the schedule on its own actual open date, and both opening and closing were open to any logged-in user. The window lifecycle should be automatic, with the manager as the only human decision point.

## Decisions (all confirmed)

1. **Lifecycle** — a window opens automatically on the audit interval boundary and stays open until closed: early by a manager, or auto-closed when the next boundary fires. The next window does **not** open the moment the previous closes — it opens on schedule. An early close deliberately leaves a quiet gap until the next scheduled open; "always open" is the steady state, not a guarantee.

2. **No routine manual windows** — manual open is removed except for a one-time bootstrap: manager-only, possible only when no audit has ever existed. The `(manual)` label survives only for the bootstrap audit (`scheduled_at` NULL); the `(scheduled)` label is dropped in favor of showing the scheduled date itself.

3. **Cadence anchoring** — each audit stores `scheduled_at` (the boundary that triggered it); next boundary = last `scheduled_at` + `audit_interval_months`. The schedule never drifts. `opened_at` remains the factual record of the actual lazy-open moment; the due-ness anchor (`anchor_at`) stays on the actual `opened_at` end-of-day, unchanged.

4. **Lazy mechanism** — no background jobs. Any authenticated audit-domain request (the banner polls `GET /api/audits/status` every 60s) performs due boundary processing inline; timestamps are accurate to the first request after the boundary.

5. **Missed boundaries collapse** — if multiple boundaries pass in silence, the open window is settled once, dated at the latest missed boundary, and the new window opens from that boundary. No phantom zero-lifespan windows; the timeline records the gap.

6. **Permissions** — close is manager-only (`requireManager`), whichever reason. Scanning stays any authenticated user. Opening is automatic (bootstrap exception, decision 2).

7. **Close kind is computed, not declared** — nothing due-and-non-exempt left → `complete`; anything left → `shortfall`. Holds for manager closes and auto-closes alike; a "clean" close with remaining parts is unrecordable. No note required on either kind — the buckets are the evidence. "Must be audited" = due, non-exempt parts at snapshot time.

8. **Auto-close attribution** — `closed_by` NULL plus a system timeline event ("auto-closed at interval"); a manager close is stamped with the manager.

9. **Settlement unchanged** — due-but-unscanned → Unavailable, no grace, through the existing `changePartStatus` (`via: "audit_close"`) and Reserved-attachment settlement seams.

10. **Banner** — while a window is open it shows the live audit and its boundary; during the gap it counts down to the next scheduled open. The due/one-week/two-weeks ladder collapses: the open window is the nag.

11. **Migration** — existing audits get `scheduled_at` backfilled to their `opened_at`; any currently open window simply continues under the new rules.

## Tickets

01 schedule-anchor swap + `scheduled_at` backfill (prefactor, zero behavior change)
02 automatic window lifecycle — lazy boundary processing, collapse rule, computed close kind, bootstrap-only open
03 manager-gated close
04 banner + counting-page UI for the new lifecycle

## Doc obligations

Every ticket updates the standing documents it invalidates: `CONTEXT.md` (done at grilling — `Audit` entry rewritten, ADR 0002 written), `docs/data-model.md`, `docs/logic-map.md`, `docs/manual.md` (and README only if run instructions change). The banner-ladder and scheduling lines in `docs/logic-map.md` and `docs/manual.md` §9 are invalidated by tickets 02 and 04.
