import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";

/**
 * The timeline write path, established by the auth ticket because every
 * later domain (batches, POs, RMA orders) records notes-and-events timelines
 * through this one helper against the single append-only `events` table
 * (migration 0002): who did it (actor), when (injectable clock), what
 * (action), to what (entity type + id), and optional detail (payload JSON,
 * e.g. `{ from: "tech", to: "manager" }` for old→new values).
 *
 * Conventions for later domains:
 * - `action` is `<entity>.<past-tense-verb>`, e.g. `user.created`,
 *   `batch.closed`. Typed notes are events too — action `note.added` with
 *   the text in the payload; notes are never edited or deleted.
 * - `actorId` is null when the system itself acts (bootstrap provisioning).
 * - Read a timeline ordered by `id`: insertion order is chronological order.
 */
export interface NewEvent {
  entityType: string;
  entityId: number;
  actorId: number | null;
  action: string;
  payload?: Record<string, unknown> | null;
}

/** Appends one timeline event, stamped through the injectable clock. Returns the event id. */
export function recordEvent(
  db: Database.Database,
  clock: Clock,
  event: NewEvent
): number {
  const result = db
    .prepare(
      `INSERT INTO events (entity_type, entity_id, actor_id, at, action, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.entityType,
      event.entityId,
      event.actorId,
      clock.now().toISOString(),
      event.action,
      event.payload ? JSON.stringify(event.payload) : null
    );
  return Number(result.lastInsertRowid);
}
