# Automatic audit window lifecycle

Audits used to depend on a user remembering to open a window and choosing to close one; the cadence merely nagged, and every audit re-anchored the schedule on its own actual open date. We decided the window lifecycle is automatic: a window opens itself on the `audit_interval_months` boundary, runs until a manager closes it early or the next boundary auto-closes it, and the auto-close runs the same no-grace settlement as a manual close (due-but-unscanned parts become Unavailable). The close kind (`complete` vs `shortfall`) is computed from the outcome buckets rather than declared, so a "clean" close with parts left over is unrecordable; close is manager-gated; the schedule anchors on each audit's `scheduled_at` (the boundary that triggered it), never on the lazy actual-open moment, so the cadence cannot drift.

## Considered options

- **A real scheduler** (server cron/timer): rejected — the shop has no background infrastructure, and the banner already polls audit status every 60s, so lazy boundary processing is timely in practice.
- **Contiguous windows** (next opens the moment the previous closes): rejected — the next window opens on schedule; an early close deliberately leaves a quiet gap until the next boundary.
- **Catch-up replay of missed boundaries**: rejected — if several boundaries pass in silence, the old window is settled once at the latest missed boundary and the next opens from it; replaying every interval would create phantom zero-lifespan windows that only re-settle parts already shrunk.

## Consequences

- Timestamps are accurate to the first request after a boundary, not the boundary instant; nothing in the shop needs a 3am timestamp.
- Shrink can be settled with no human click (the boundary auto-close). This is deliberate: the shrink signal must not depend on anyone remembering to close.
- The only manual open left is the one-time bootstrap of the very first window (manager-only, when no audit exists); the cadence is always derived from a real, existing audit.
