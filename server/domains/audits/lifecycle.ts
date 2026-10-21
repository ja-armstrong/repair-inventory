import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";
import type { CurrentUser } from "../auth/session.js";
import { changePartStatus, type PartStatus } from "../parts/status.js";
import { settleAttachmentForAuditFailure } from "../batchparts/queries.js";
import { duePartsAtOpen, type CountablePartRow } from "./counting.js";
import { addMonthsUTC, endOfUTCDay } from "./schedule.js";
import { getSettingInt } from "../parts/settings.js";

/**
 * The audit window lifecycle core (ticket 02, ADR-0002): the ONE writer of
 * `audits` rows and `audit_parts.outcome`, shared by the HTTP routes and the
 * lazy boundary processor.
 *
 * The lifecycle is automatic (ADR-0002): a window opens itself on the
 * `audit_interval_months` boundary and runs until a manager closes it early
 * or the next boundary auto-closes it. There are no background jobs — the
 * boundary check runs lazily on any authenticated audits-domain request
 * (the banner's 60-second status poll is the natural trigger), so
 * timestamps are accurate to the first request after the boundary, never
 * the boundary instant.
 *
 * WHY the collapse rule: if several boundaries pass in silence, replaying
 * each one would settle the same shrink twice and create phantom
 * zero-lifespan windows. Instead the open window is settled exactly once
 * (at the first request after the silence) and the new window opens from
 * the LATEST missed boundary — skipped windows never exist, and the
 * timeline records the gap via the auto-close event's missedBoundaryCount.
 *
 * WHY one transaction per transition: auto-close + auto-open land together
 * or not at all, so "exactly one open window" survives even the request
 * that crosses a boundary.
 */

export interface AuditRow {
  id: number;
  scheduled_at: string | null;
  opened_at: string;
  opened_by: number;
  closed_at: string | null;
  closed_by: number | null;
  close_kind: string | null;
  previous_audit_id: number | null;
  anchor_at: string | null;
  opened_by_email: string;
  closed_by_email: string | null;
}

export const AUDIT_SELECT = `
  SELECT a.id, a.scheduled_at, a.opened_at, a.opened_by, a.closed_at, a.closed_by,
         a.close_kind, a.previous_audit_id, a.anchor_at,
         ua.email AS opened_by_email, uc.email AS closed_by_email
    FROM audits a
    JOIN users ua ON ua.id = a.opened_by
    LEFT JOIN users uc ON uc.id = a.closed_by
`;

export function getAuditRow(db: Database.Database, id: number): AuditRow | undefined {
  return db.prepare(`${AUDIT_SELECT} WHERE a.id = ?`).get(id) as AuditRow | undefined;
}

export function openAuditId(db: Database.Database): number | null {
  const row = db.prepare("SELECT id FROM audits WHERE closed_at IS NULL").get() as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

export interface SnapshotRow extends CountablePartRow {
  outcome: string | null;
}

const SNAPSHOT_SELECT = `
  SELECT ap.outcome, p.id, p.serial, p.status, p.last_counted_at, p.created_at, p.sku_id, s.name AS sku_name
    FROM audit_parts ap
    JOIN serialized_parts p ON p.id = ap.part_id
    JOIN skus s ON s.id = p.sku_id
   WHERE ap.audit_id = ?
   ORDER BY p.id
`;

export function snapshotRows(db: Database.Database, auditId: number): SnapshotRow[] {
  return db.prepare(SNAPSHOT_SELECT).all(auditId) as SnapshotRow[];
}

export type CloseKind = "complete" | "shortfall";

/**
 * The close kind is COMPUTED from the outcome buckets, never declared
 * (spec decision 7): any due part that failed the audit means shortfall.
 * A manager cannot record a "clean" close with parts left over — the
 * buckets are the evidence, on auto-closes and manager closes alike.
 */
export function computedCloseKind(failed: number): CloseKind {
  return failed > 0 ? "shortfall" : "complete";
}

/**
 * Open a window. `scheduledAt` is the BOUNDARY that triggered this window,
 * never the moment it actually opened (ADR-0002) — the cadence anchors
 * there, so a lazy open after its boundary cannot drift the schedule. NULL
 * means no boundary triggered it, which after ticket 02 is only ever the
 * bootstrap audit (opened by a manager on a system with no audits at all);
 * such an audit anchors the cadence on its own opened_at.
 *
 * The due-ness anchor is a different thing on purpose: it stays on the
 * previous audit's actual open DAY (end of UTC day), because "counted
 * since last time" is day-granular.
 */
export function openAuditWindow(
  db: Database.Database,
  clock: Clock,
  actor: CurrentUser,
  scheduledAt: string | null,
  note: string | null
): number {
  const now = clock.now();
  const previous = db
    .prepare("SELECT id, opened_at FROM audits ORDER BY id DESC LIMIT 1")
    .get() as { id: number; opened_at: string } | undefined;
  const anchorAt = previous ? endOfUTCDay(new Date(previous.opened_at)).toISOString() : null;

  const open = db.transaction((): number => {
    const result = db
      .prepare(
        `INSERT INTO audits (scheduled_at, opened_at, opened_by, closed_at, closed_by, close_kind, previous_audit_id, anchor_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)`
      )
      .run(scheduledAt, now.toISOString(), actor.id, previous?.id ?? null, anchorAt);
    const auditId = Number(result.lastInsertRowid);
    // The due list is computed at OPEN time and snapshotted, so a part
    // added while the window is open is never demanded by that audit.
    const due = duePartsAtOpen(db, anchorAt);
    for (const part of due) {
      db.prepare("INSERT INTO audit_parts (audit_id, part_id, outcome) VALUES (?, ?, NULL)").run(
        auditId,
        part.id
      );
    }
    recordEvent(db, clock, {
      entityType: "audit",
      entityId: auditId,
      actorId: actor.id,
      action: "audit.opened",
      payload: {
        scheduledAt,
        previousAuditId: previous?.id ?? null,
        anchorAt,
        demanded: due.length,
        ...(note ? { note } : {}),
      },
    });
    return auditId;
  });
  return open();
}

export interface CloseCounts {
  counted: number;
  failed: number;
  moved: number;
}

export interface CloseRecord {
  counts: CloseCounts;
  closeKind: CloseKind;
}

export interface CloseCall {
  /** The user whose request performs the settlement writes (part flips, attachment settlement). */
  actor: CurrentUser;
  /**
   * What the audit records as its closer: the manager on a manual close,
   * NULL on an auto-close — `closed_by` NULL is what marks an audit as
   * auto-closed (spec decision 8).
   */
  closedBy: CurrentUser | null;
  note: string | null;
  /** Present only on a boundary auto-close; recorded on the system timeline event. */
  auto?: { boundary: string; missedBoundaryCount: number };
}

/**
 * Close a window with the unchanged no-grace settlement: counted (scanned
 * in-window), failed (due, still in circulation → Unavailable, through the
 * part-status module and the Reserved-attachment seam), moved (accounted
 * for mid-window).
 *
 * WHY two attributions: the part-level settlement events name the user
 * whose request triggered the close (there is no system user to attribute a
 * guarded status flip to), while the audit's OWN record keeps `closed_by`
 * NULL on an auto-close and its timeline event actor-less ("auto-closed at
 * interval").
 */
export function closeAuditWindow(
  db: Database.Database,
  clock: Clock,
  audit: AuditRow,
  call: CloseCall
): CloseRecord {
  const { actor, closedBy, note, auto } = call;
  const now = clock.now().toISOString();

  const close = db.transaction((): CloseRecord => {
    const stamp = db.prepare("UPDATE audit_parts SET outcome = ? WHERE audit_id = ? AND part_id = ?");
    const pending = snapshotRows(db, audit.id).filter((row) => row.outcome === null);
    const counts: CloseCounts = { counted: 0, failed: 0, moved: 0 };
    for (const row of pending) {
      const scanned = row.last_counted_at !== null && row.last_counted_at >= audit.opened_at;
      if (scanned) {
        stamp.run("counted", audit.id, row.id);
        counts.counted += 1;
        continue;
      }
      if (row.status === "available" || row.status === "reserved") {
        // No grace: the shrink signal. The failure event on the part's
        // timeline names the audit it failed.
        const failureNote = `failed audit #${audit.id} — due but not counted`;
        if (row.status === "reserved") {
          // Hole 2 (ticket 14): a Reserved part's device_parts attachment
          // is settled HERE, in the same transaction — through the
          // batchparts seam (the device_parts owner), not a raw UPDATE.
          // Without it the attachment dangled and the next swap failed
          // with a misleading race error.
          settleAttachmentForAuditFailure(db, clock, actor.id, {
            partId: row.id,
            serial: row.serial,
            sku: row.sku_name,
            auditId: audit.id,
            note: failureNote,
          });
        }
        // Through the part-status module (ticket 14): guarded flip +
        // part.status_changed event recording live there.
        const failed = changePartStatus(db, clock, actor, {
          partId: row.id,
          to: "unavailable",
          note: failureNote,
          via: "audit_close",
          expectedFrom: row.status as PartStatus,
        });
        if (!failed.ok) {
          throw new Error(`audit close could not fail part ${row.serial}: ${failed.message}`);
        }
        stamp.run("failed", audit.id, row.id);
        counts.failed += 1;
        continue;
      }
      // Someone accounted for this part mid-window with a status change
      // (its own timeline carries their note) — not a shrink signal.
      stamp.run("moved", audit.id, row.id);
      counts.moved += 1;
    }
    const closeKind = computedCloseKind(counts.failed);
    db.prepare("UPDATE audits SET closed_at = ?, closed_by = ?, close_kind = ? WHERE id = ?").run(
      now,
      closedBy?.id ?? null,
      closeKind,
      audit.id
    );
    recordEvent(db, clock, {
      entityType: "audit",
      entityId: audit.id,
      // actorId NULL = the system closed it (the boundary fired); a manager
      // close is stamped with the manager (spec decision 8).
      actorId: closedBy?.id ?? null,
      action: "audit.closed",
      payload: {
        demanded: snapshotRows(db, audit.id).length,
        ...counts,
        closeKind,
        ...(auto
          ? {
              // The collapse rule's record: the boundary that triggered the
              // auto-close and how many had passed in silence.
              auto: true,
              reason: "interval",
              boundary: auto.boundary,
              missedBoundaryCount: auto.missedBoundaryCount,
            }
          : {}),
        ...(note ? { note } : {}),
      },
    });
    return { counts, closeKind };
  });
  return close();
}

/** The latest `anchor + k * interval` that is at or before `now`, or NULL when none is. */
export function latestMissedBoundary(
  anchor: Date,
  intervalMonths: number,
  now: Date
): { boundary: Date; missed: number } | null {
  // Loud guard, not a fallback: the settings seam validates interval >= 1,
  // and a non-positive interval here would loop forever.
  if (!Number.isInteger(intervalMonths) || intervalMonths < 1) {
    throw new Error(`audit_interval_months must be a whole number >= 1, got ${intervalMonths}`);
  }
  let boundary = addMonthsUTC(anchor, intervalMonths);
  let latest: Date | null = null;
  let missed = 0;
  // 1200 iterations = 100 years at the minimum interval — unreachable for
  // a sane clock; the throw turns a corrupt clock into a loud failure
  // instead of a hang.
  while (missed < 1200) {
    if (boundary.getTime() > now.getTime()) {
      break;
    }
    latest = boundary;
    missed += 1;
    boundary = addMonthsUTC(boundary, intervalMonths);
  }
  if (latest === null) {
    return null;
  }
  if (missed >= 1200) {
    throw new Error(`audit boundary search ran past its 1200-boundary guard — clock or interval is corrupt`);
  }
  return { boundary: latest, missed };
}

export interface BoundaryTransition {
  /** The audit auto-closed by this transition, if a window was open. */
  closedAuditId: number | null;
  /** The window opened from the latest missed boundary. */
  openedAuditId: number;
  /** The latest missed boundary, ISO — the new window's `scheduled_at`. */
  boundary: string;
  /** How many boundaries had passed in silence (>= 1; the timeline's gap record). */
  missedBoundaryCount: number;
}

/**
 * The lazy boundary check every authenticated audits-domain request runs
 * first (the banner polls GET /api/audits/status every 60 seconds, so shop
 * time is covered without any background job). When at least one
 * `audit_interval_months` boundary has passed since the last audit's
 * cadence anchor, it settles the open window (if any) and opens the next
 * one from the LATEST missed boundary, in ONE transaction.
 *
 * There is no schedule until the first audit exists, and an early manual
 * close deliberately leaves a quiet gap: the next window opens on schedule,
 * not on close (ADR-0002).
 */
export function processDueBoundaries(
  db: Database.Database,
  clock: Clock,
  actor: CurrentUser
): BoundaryTransition | null {
  const intervalMonths = getSettingInt(db, "audit_interval_months");
  const last = db
    .prepare("SELECT id, scheduled_at, opened_at FROM audits ORDER BY id DESC LIMIT 1")
    .get() as { id: number; scheduled_at: string | null; opened_at: string } | undefined;
  if (!last) {
    return null;
  }
  // The cadence anchor is the boundary that triggered the last audit; when
  // none did (the bootstrap audit), its own open date is the anchor — the
  // schedule always derives from a real, existing audit (ticket 01).
  const anchor = last.scheduled_at ? new Date(last.scheduled_at) : new Date(last.opened_at);
  const missed = latestMissedBoundary(anchor, intervalMonths, clock.now());
  if (!missed) {
    return null;
  }
  const boundaryIso = missed.boundary.toISOString();
  const transition = db.transaction((): BoundaryTransition => {
    const openId = openAuditId(db);
    let closedAuditId: number | null = null;
    if (openId !== null) {
      const audit = getAuditRow(db, openId);
      if (!audit) {
        throw new Error(`open audit window ${openId} disappeared mid-boundary-processing`);
      }
      closeAuditWindow(db, clock, audit, {
        // The boundary closed it: the audit's closer is the system, while
        // the triggering user performs the settlement writes.
        actor,
        closedBy: null,
        note: null,
        auto: {
          boundary: boundaryIso,
          missedBoundaryCount: missed.missed,
        },
      });
      closedAuditId = openId;
    }
    const openedAuditId = openAuditWindow(db, clock, actor, boundaryIso, null);
    return { closedAuditId, openedAuditId, boundary: boundaryIso, missedBoundaryCount: missed.missed };
  });
  return transition();
}
