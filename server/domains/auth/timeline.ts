import { Router } from "express";
import type Database from "better-sqlite3";
import type { AppContext } from "../../domain.js";
import { recordEvent } from "./events.js";

/**
 * The timeline READ path (ticket 14): one module, one event shape, for every
 * domain. The write path is `events.ts:recordEvent`; this is its read-side
 * twin — one query shape (events joined to users, ordered by id, oldest
 * first) and ONE JSON shape for events:
 *
 *   { id, at, action, actor: {id, email} | null, entityType, entityId, payload }
 *
 * The `actor` object is the richer of the two shapes that used to coexist
 * (batches/POs emitted {id, email}; parts/RMA/audits emitted the bare email
 * string) — CONTEXT.md promises one timeline, so the API speaks one dialect.
 *
 * The note-endpoint factory (registerNotesRoute) is the one POST /:id/notes
 * implementation the batch, PO, RMA, buyback, and return routers share:
 * validate, 404, transaction, recordEvent, return the serialized event.
 * Notes are immutable everywhere — no edit or delete route exists, on purpose.
 */

export interface TimelineEventRow {
  id: number;
  entity_type: string;
  entity_id: number;
  actor_id: number | null;
  actor_email: string | null;
  at: string;
  action: string;
  payload: string | null;
}

export interface TimelineEvent {
  id: number;
  at: string;
  action: string;
  actor: { id: number; email: string } | null;
  entityType: string;
  entityId: number;
  payload: Record<string, unknown> | null;
}

export function serializeTimelineEvent(row: TimelineEventRow): TimelineEvent {
  return {
    id: row.id,
    at: row.at,
    action: row.action,
    actor: row.actor_id === null ? null : { id: row.actor_id, email: row.actor_email as string },
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: row.payload === null ? null : (JSON.parse(row.payload) as Record<string, unknown>),
  };
}

/**
 * The timeline query: one WHERE clause over the events table, joined to
 * users for the actor, ordered by id (insertion order is chronological
 * order). Domains keep their own WHERE (batches merges its devices' events
 * into the batch's timeline); the shape and the join live here.
 */
export function timelineEvents(
  db: Database.Database,
  where: string,
  params: unknown[]
): TimelineEvent[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.entity_type, e.entity_id, e.actor_id, u.email AS actor_email,
              e.at, e.action, e.payload
         FROM events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE ${where}
        ORDER BY e.id`
    )
    .all(...params) as TimelineEventRow[];
  return rows.map(serializeTimelineEvent);
}

/** One entity's timeline, oldest first. */
export function timelineFor(
  db: Database.Database,
  entityType: string,
  entityId: number
): TimelineEvent[] {
  return timelineEvents(db, "e.entity_type = ? AND e.entity_id = ?", [entityType, entityId]);
}

export interface NoteRouteOptions {
  /** The event entity type these notes attach to ("batch", "po", "rma", "buyback", "return"). */
  entityType: string;
  /** The 404 message when the entity does not exist. */
  notFoundMessage: string;
  /**
   * The 400 message for a malformed id. Omit it when a malformed id should
   * 404 like a missing entity (the batches route's historical behavior).
   */
  invalidIdMessage?: string;
  /** The domain's own existence check for the entity row. */
  exists: (db: Database.Database, id: number) => boolean;
}

/**
 * Mounts POST /:id/notes on the given router — the single note endpoint all
 * note-carrying domains share. Behavior per CONTEXT.md: a note is required,
 * user-stamped, immutable, and merges into the entity's one timeline.
 */
export function registerNotesRoute(
  router: Router,
  ctx: AppContext,
  options: NoteRouteOptions
): void {
  router.post("/:id/notes", (req, res) => {
    const text = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (text === "") {
      res.status(400).json({ error: "note text is required" });
      return;
    }
    const id = Number(req.params.id);
    const valid = Number.isInteger(id) && id > 0;
    if (!valid && options.invalidIdMessage !== undefined) {
      res.status(400).json({ error: options.invalidIdMessage });
      return;
    }
    if (!valid || !options.exists(ctx.db, id)) {
      res.status(404).json({ error: options.notFoundMessage });
      return;
    }
    const actor = req.currentUser!;
    const add = ctx.db.transaction((): number =>
      recordEvent(ctx.db, ctx.clock, {
        entityType: options.entityType,
        entityId: id,
        actorId: actor.id,
        action: "note.added",
        payload: { text },
      })
    );
    const eventId = add();
    const event = timelineEvents(ctx.db, "e.id = ?", [eventId])[0];
    res.status(201).json(event);
  });
}
