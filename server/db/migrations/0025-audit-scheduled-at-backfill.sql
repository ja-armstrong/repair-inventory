-- 0025: backfill audits.scheduled_at = opened_at (ticket 01, schedule-anchor
-- swap; spec decision 11 of .scratch/audit-window-lifecycle).
--
-- The audit cadence now derives from the last audit's scheduled_at — the
-- boundary that triggered it — instead of its opened_at (ADR-0002). Every
-- pre-lifecycle audit was opened by a user at or after its boundary and the
-- old schedule anchored on opened_at, so backfilling scheduled_at to the
-- actual open date keeps every derived next boundary bit-identical: the swap
-- lands with zero behavior change. From here on the open route stamps
-- scheduled_at itself (the boundary when the open matches the cadence; still
-- NULL for a transitional manual early open, which anchors the cadence on its
-- own opened_at until the automatic lifecycle lands).

UPDATE audits SET scheduled_at = opened_at;
