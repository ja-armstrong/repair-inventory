import type Database from "better-sqlite3";
import { getSettingInt } from "../parts/settings.js";

/**
 * The audit calendar (ticket 10). All time is UTC and flows through the
 * injectable clock; the calendar math here is what turns "every 2 months"
 * into a date and a date into banner stages.
 *
 * Scheduling model (ticket 01, schedule-anchor swap; ADR-0002): the NEXT
 * audit is the LAST audit's scheduled_at — the boundary that triggered it —
 * plus audit_interval_months. Anchoring on the boundary rather than the
 * actual open moment is what keeps the cadence from drifting later audit by
 * audit once windows open lazily, after their boundary. An audit no boundary
 * triggered (the very first one, or a transitional manual early open) has
 * scheduled_at NULL and anchors the cadence on its own opened_at — the
 * cadence is always derived from a real, existing audit, and there is no
 * schedule until the first audit exists. Migration 0025 backfilled every
 * pre-lifecycle audit's scheduled_at to its opened_at, so the swap itself
 * changed no derived boundary.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function daysInUTCMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Calendar-month arithmetic in UTC, day-clamped: 01.31 + 1 month = 02.28. */
export function addMonthsUTC(at: Date, months: number): Date {
  const total = at.getUTCMonth() + months;
  const year = at.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const day = Math.min(at.getUTCDate(), daysInUTCMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      at.getUTCHours(),
      at.getUTCMinutes(),
      at.getUTCSeconds(),
      at.getUTCMilliseconds()
    )
  );
}

/**
 * The due-ness anchor: the last instant of the previous audit's open DAY.
 * The rule is day-granular ("last count falls on or before the previous
 * audit"), so a count taken during the previous audit itself — on its open
 * day — is due again at the next audit; only counts taken between audits
 * (cycle counts) exempt a part.
 */
export function endOfUTCDay(at: Date): Date {
  const startOfNextDay = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return new Date(startOfNextDay.getTime() + DAY_MS - 1);
}

export interface AuditSchedule {
  intervalMonths: number;
  /** The last audit's factual open moment (`opened_at`) — unchanged meaning, display only. */
  lastAuditAt: Date | null;
  /** The last audit's `scheduled_at` — the boundary that triggered it; NULL when none did. */
  lastScheduledAt: Date | null;
  nextAuditAt: Date | null;
}

export function auditSchedule(db: Database.Database): AuditSchedule {
  const intervalMonths = getSettingInt(db, "audit_interval_months");
  const row = db
    .prepare("SELECT scheduled_at, opened_at FROM audits ORDER BY id DESC LIMIT 1")
    .get() as { scheduled_at: string | null; opened_at: string } | undefined;
  const lastAuditAt = row ? new Date(row.opened_at) : null;
  const lastScheduledAt = row?.scheduled_at ? new Date(row.scheduled_at) : null;
  // The cadence anchor is the boundary that triggered the last audit; when
  // none did (first audit, transitional manual open), its own open date is
  // the anchor — the schedule always derives from a real, existing audit.
  const anchor = lastScheduledAt ?? lastAuditAt;
  return {
    intervalMonths,
    lastAuditAt,
    lastScheduledAt,
    nextAuditAt: anchor ? addMonthsUTC(anchor, intervalMonths) : null,
  };
}

/**
 * Banner stages the client polls (GET /api/audits/status). An open window
 * always wins; otherwise the reminder ladder counts down to the scheduled
 * audit: two weeks out, one week out, due. The two-week and one-week marks
 * are per spec story 59 (both inclusive at exactly 14 / 7 days).
 */
export type BannerStage = "open" | "due" | "one-week" | "two-weeks" | null;

export function bannerStage(
  now: Date,
  nextAuditAt: Date | null,
  openAuditId: number | null
): BannerStage {
  if (openAuditId !== null) {
    return "open";
  }
  if (nextAuditAt === null) {
    return null;
  }
  const until = nextAuditAt.getTime() - now.getTime();
  if (until <= 0) {
    return "due";
  }
  if (until <= 7 * DAY_MS) {
    return "one-week";
  }
  if (until <= 14 * DAY_MS) {
    return "two-weeks";
  }
  return null;
}
