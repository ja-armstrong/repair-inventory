import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";
import type { CurrentUser } from "../auth/session.js";
import { changePartStatus, partStatusLabel, type PartStatus } from "../parts/status.js";

/**
 * The counting core (ticket 10): which parts an audit demands, why a part
 * is exempt, and what one scan does — refresh the last-count date, record
 * the event, and let physical presence win over a disagreeing recorded
 * status (with a required note).
 *
 * Per CONTEXT.md and the ticket:
 * - Demanded: Available and Reserved parts whose last count falls on or
 *   before the previous audit. Reserved parts ARE in scope (committed to a
 *   Batch, still on the shelf).
 * - Exempt: Unavailable and Damaged by Tech parts (out of circulation —
 *   not re-scanned), RMA parts (slated for return), Buyback parts (slated
 *   for sale to a supplier's program, ticket 27), and In-Transit parts
 *   (attached to an open RMA/buyback/return order — physically gone,
 *   ticket 29: the status itself is now the real check).
 */

export type ExemptReason =
  | "in-transit"
  | "rma"
  | "buyback"
  | "unavailable"
  | "damaged_by_tech"
  | "recently-counted"
  | "added-since-open";

export interface CountablePartRow {
  id: number;
  serial: string;
  status: string;
  last_counted_at: string | null;
  created_at: string;
  sku_id: number;
  sku_name: string;
}

const PART_SELECT = `
  SELECT p.id, p.serial, p.status, p.last_counted_at, p.created_at, p.sku_id, s.name AS sku_name
    FROM serialized_parts p JOIN skus s ON s.id = p.sku_id
`;

export function getPartBySerial(db: Database.Database, serial: string): CountablePartRow | undefined {
  return db.prepare(`${PART_SELECT} WHERE p.serial = ?`).get(serial) as
    | CountablePartRow
    | undefined;
}

export function getSkuKind(db: Database.Database, skuId: number): { id: number; kind: string; name: string } | undefined {
  return db.prepare("SELECT id, kind, name FROM skus WHERE id = ?").get(skuId) as
    | { id: number; kind: string; name: string }
    | undefined;
}

/** Why a part is exempt from being demanded, or null when it is not exempt. */
export function exemptionReason(
  _db: Database.Database,
  part: Pick<CountablePartRow, "id" | "status">
): ExemptReason | null {
  // Ticket 29: In-Transit IS the physically-gone marker — attached to an
  // open outbound order by definition — so the exemption reads the status
  // directly instead of guessing through the order tables.
  if (part.status === "in_transit") {
    return "in-transit";
  }
  if (part.status === "rma") {
    return "rma";
  }
  if (part.status === "buyback") {
    return "buyback";
  }
  if (part.status === "unavailable") {
    return "unavailable";
  }
  if (part.status === "damaged_by_tech") {
    return "damaged_by_tech";
  }
  return null;
}

/**
 * The due list at OPEN time — snapshotted into audit_parts. Anchor null
 * (the first audit) means no previous audit exists, so every part in
 * circulation is due: the first audit establishes the baseline count.
 */
export function duePartsAtOpen(db: Database.Database, anchorAt: string | null): CountablePartRow[] {
  if (anchorAt === null) {
    return db
      .prepare(`${PART_SELECT} WHERE p.status IN ('available', 'reserved') ORDER BY p.id`)
      .all() as CountablePartRow[];
  }
  return db
    .prepare(
      `${PART_SELECT}
        WHERE p.status IN ('available', 'reserved')
          AND (p.last_counted_at IS NULL OR p.last_counted_at <= ?)
        ORDER BY p.id`
    )
    .all(anchorAt) as CountablePartRow[];
}

export function serializePartView(row: CountablePartRow) {
  return {
    id: row.id,
    serial: row.serial,
    skuId: row.sku_id,
    skuName: row.sku_name,
    status: row.status,
    statusLabel: partStatusLabel(row.status),
    lastCountedAt: row.last_counted_at,
  };
}

/** Statuses whose recorded meaning is "not on the shelf" — a scan of such a part disagrees with physical presence. */
export function scanDisagreesWithStatus(status: string): boolean {
  return (
    status === "unavailable" ||
    status === "rma" ||
    status === "buyback" ||
    status === "in_transit"
  );
}

export type CountContext =
  | { kind: "audit"; auditId: number }
  | { kind: "cycle_count"; skuId: number }
  // Ticket 13: migration intake with a confirmed physical count. The refresh
  // is a real count through this one seam so audit due-ness treats migrated
  // shelf stock exactly like anything else that was counted.
  | { kind: "migration_intake" };

/**
 * One scan, audit or cycle count alike. In one transaction: the last-count
 * date refreshes, `part.counted` lands on the part's timeline, and — when
 * the recorded status says the part shouldn't be here — the scan wins: the
 * part becomes Available and `part.status_changed` records the required
 * note. Callers must refuse a missing note when `scanDisagreesWithStatus`
 * holds for the part's current status.
 */
export function applyCount(
  db: Database.Database,
  clock: Clock,
  actor: CurrentUser,
  part: CountablePartRow,
  context: CountContext,
  note: string | null
): { statusChanged: boolean } {
  const disagrees = scanDisagreesWithStatus(part.status);
  const now = clock.now().toISOString();
  const count = db.transaction((): void => {
    db.prepare("UPDATE serialized_parts SET last_counted_at = ? WHERE id = ?").run(now, part.id);
    recordEvent(db, clock, {
      entityType: "part",
      entityId: part.id,
      actorId: actor.id,
      action: "part.counted",
      payload: {
        context: context.kind,
        ...(context.kind === "audit" ? { auditId: context.auditId } : {}),
        previousLastCountedAt: part.last_counted_at,
        ...(disagrees ? { restoredFrom: part.status } : {}),
        ...(note !== null ? { note } : {}),
      },
    });
    if (disagrees) {
      // The scan wins — through the part-status module (ticket 14): the
      // guarded flip and the part.status_changed event recording live there.
      const restored = changePartStatus(db, clock, actor, {
        partId: part.id,
        to: "available",
        note: note ?? "",
        via: "scan_wins",
        expectedFrom: part.status as PartStatus,
      });
      if (!restored.ok) {
        throw new Error(`scan-wins could not restore part ${part.serial}: ${restored.message}`);
      }
    }
  });
  count();
  return { statusChanged: disagrees };
}
