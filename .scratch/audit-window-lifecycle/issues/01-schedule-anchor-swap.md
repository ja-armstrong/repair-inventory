# 01 — Schedule-anchor swap: cadence derives from `scheduled_at`

Status: ready-for-human

## Problem

The audit cadence re-anchors on each audit's actual `opened_at`. Under the coming automatic lifecycle (spec decisions 1/3), windows open lazily — the actual open moment is "first request after the boundary" — so anchoring the cadence on it would drift the schedule later forever, compounding audit by audit.

## What to build

Zero observable behavior change; the anchor swap lands green:

- Migration: backfill `scheduled_at` = `opened_at` for every existing `audits` row. Because all existing windows were opened by users at or after their boundary, the derived next boundary is bit-identical before and after.
- Scheduling derives the next boundary from the last audit's `scheduled_at` + `audit_interval_months`, replacing the `opened_at` anchor. "No schedule until the first audit exists" still holds.
- The open route stamps `scheduled_at` under the new rule (the transitional manual-open behavior itself changes in ticket 02 — do not pre-implement bootstrap gating here).
- `scheduled_at` rides the audit status and detail payloads so the UI can later show the schedule and count down to the next boundary.
- Any currently open window simply continues under the new anchoring; no special migration case.

## Blocked by

None (can start immediately).

## Acceptance

- [ ] All existing `audits` rows carry `scheduled_at` = `opened_at` after migration.
- [ ] Next boundary = last `scheduled_at` + `audit_interval_months`; existing tests pass unchanged (proof of zero behavior change).
- [ ] New tests: a backfilled history produces the same `nextAuditAt` as before the swap; a manually opened early window still re-anchors on its own dates until ticket 02 lands.
- [ ] Status and detail payloads expose the schedule dates.

## Doc obligations

- `docs/data-model.md`: `scheduled_at` semantics (the boundary that triggered the audit; backfilled = `opened_at` for pre-lifecycle audits) and invariant #8 wording.
- `docs/logic-map.md`: the "Scheduling (derived, not stored)" paragraph — cadence anchored on `scheduled_at`.
- `docs/manual.md` §9: only if its plain-English scheduling statement becomes wrong (it should not yet).

## Comments

- Origin: grilling session 2026-10-05 (`.scratch/audit-window-lifecycle/spec.md` decisions 3 and 11). Prefactor for the automatic lifecycle: make the anchor swap easy, then make the easy change.
- Ticket 01 implemented (schedule-anchor swap). `server/db/migrations/0025-audit-scheduled-at-backfill.sql` backfills `audits.scheduled_at` = `opened_at` for every existing row. `auditSchedule` (server/domains/audits/schedule.ts) now anchors the cadence on the last audit's `scheduled_at` + `audit_interval_months`; when no boundary triggered the last audit (`scheduled_at` NULL — the very first audit, or a transitional manual early open) that audit's own `opened_at` is the anchor. That fallback is a deliberate, documented rule, not a silent default: it is what keeps "no schedule until the first audit exists" true while the existing suite pins the first audit's `scheduledAt` to NULL, and it is the same rule ticket 02's bootstrap audit will live under.
- The open route's stamping shape is unchanged (boundary when now ≥ next boundary, NULL otherwise) — the swap happens through `auditSchedule`'s anchor. Transitional manual-open behavior left as-is (no bootstrap gating). Due-ness anchor (`anchor_at`) untouched, still on the previous `opened_at` end-of-day.
- `GET /api/audits/status` now also exposes `lastScheduledAt` (the last audit's `scheduled_at`); `lastAuditAt` keeps its exact old meaning (the last audit's `opened_at`), so the web client's existing reads are untouched. Detail and list payloads already carried `scheduledAt`.
- Tests (server/tests/audits.test.ts, 3 new): (1) migration 0025 rebuilds a pre-swap database (0011-style ledger trick: full migrate, delete the 0025 ledger row, insert pre-swap-shaped rows — a NULL-scheduled first audit and a scheduled audit whose lazy open lags its boundary — then re-run the runner) and asserts every row comes out `scheduled_at` = `opened_at` with `nextAuditAt` bit-identical to the pre-swap `opened_at`-anchored value; (2) a manually opened early window still re-anchors on its own dates (nextAuditAt = own open + interval, `lastScheduledAt` NULL); (3) a window opened one day past its boundary stamps the boundary as `scheduled_at` and the next boundary derives from it (05.01, not the drifted 05.02) — the direct proof of the swap.
- Full suite: 27 files / 532 tests passed (was 529 + 3 new); `npm run typecheck` clean.
- Docs: `docs/data-model.md` (0025 row added to the migration list — the list had drifted and stopped at 0021, so the missing 0022–0024 rows were filled in from the migration files; `audits.scheduled_at` semantics rewritten; the audits invariants paragraph and standing invariant #8 reworded to the `scheduled_at` anchor), `docs/logic-map.md` (the "Scheduling (derived, not stored)" paragraph and the status route line). `docs/manual.md` §9 left untouched — "The app counts stock on a schedule. The default is every 2 months." is still literally true; tickets 02/04 invalidate it. CONTEXT.md and ADR-0002 already carried the decision from the grilling session.
