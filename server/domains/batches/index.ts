import { Router } from "express";
import type { Express } from "express";
import type { AppContext, Domain } from "../../domain.js";
import { getApiRouter } from "../auth/index.js";
import { requireManager } from "../auth/session.js";
import { recordEvent } from "../auth/events.js";
import { registerNotesRoute, timelineEvents } from "../auth/timeline.js";
import { registerDeviceRoutes } from "./devices.js";
import { registerModelRoutes } from "./models.js";
import {
  approveBatch,
  closeBatch,
  createBatchRecord,
} from "./lifecycle.js";
import {
  BATCH_SELECT,
  getBatchRow,
  serializeBatchDetail,
  serializeBatchSummary,
  type BatchRow,
} from "./serialize.js";

/**
 * The batches domain: batch records (the authoritative repair record),
 * their device rows, the maintained Model list, and the per-batch timeline.
 * Registered after auth in server/bootstrap.ts; routes attach to the
 * session-gated /api router, so `req.currentUser` is always set.
 *
 * Lifecycle (ticket 06): a batch starts in Awaiting approval; a manager's
 * approval (a cost sign-off — the event records the approved Parts Cost
 * total) opens it; any user may close it once every device is terminal.
 * The lifecycle transitions live in batches/lifecycle.ts — this file is
 * only the HTTP edge. Device-level Repair Statuses remain graph-checked in
 * statuses.ts; notes and system events merge into one immutable
 * chronological timeline via recordEvent.
 */

// The batch's merged timeline: the batch's own events AND its devices'
// events, one chronological list — the WHERE stays here (it is batch
// structure); the join, ordering, and event shape live in auth/timeline.ts.
const TIMELINE_WHERE = `
  (e.entity_type = 'batch' AND e.entity_id = ?)
  OR (e.entity_type = 'device'
      AND e.entity_id IN (SELECT id FROM devices WHERE batch_id = ?))
`;

// With a middleware in the handler list, express' route typings widen params
// to `string | string[]` — parse defensively (same shape as parsePoId).
function parseBatchId(raw: string | string[] | undefined): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export const batchesDomain: Domain = {
  name: "batches",
  register(app: Express, ctx: AppContext): void {
    const api = getApiRouter(app);
    const batches = Router();

    batches.post("/", (req, res) => {
      const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
      if (note === "") {
        res.status(400).json({ error: "an opening note is required" });
        return;
      }
      const actor = req.currentUser!;
      const created = ctx.db.transaction(() =>
        createBatchRecord(ctx.db, ctx.clock, actor, note)
      );
      const { id } = created();
      res.status(201).json(serializeBatchSummary(ctx.db, getBatchRow(ctx.db, id)!));
    });

    batches.get("/", (_req, res) => {
      // One query through the shared BATCH_SELECT (ticket 01): the previous
      // ad-hoc SELECT here omitted b.status and the approved/closed fields,
      // then cast the rows `as BatchRow` — serializeBatchSummary read the
      // missing fields as undefined and JSON silently dropped the keys, so
      // every list row's Status rendered blank. Same source of truth as the
      // detail route now.
      const rows = ctx.db
        .prepare(`${BATCH_SELECT} ORDER BY b.number DESC`)
        .all() as BatchRow[];
      res.json(rows.map((row) => serializeBatchSummary(ctx.db, row)));
    });

    batches.get("/:id", (req, res) => {
      const id = parseBatchId(req.params.id);
      const row = id === undefined ? undefined : getBatchRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no batch with that id" });
        return;
      }
      res.json(serializeBatchDetail(ctx.db, row, req.currentUser!));
    });

    // Manager approval: the cost sign-off (spec story 35). The lifecycle
    // rules live in lifecycle.ts; here is only the HTTP edge.
    batches.post("/:id/approve", requireManager, (req, res) => {
      const id = parseBatchId(req.params.id);
      const row = id === undefined ? undefined : getBatchRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no batch with that id" });
        return;
      }
      const rawNote: unknown = req.body?.note;
      // Absent means no note; a given-but-blank note is refused loudly
      // inside approveBatch (optional never means silently dropped).
      const note = typeof rawNote === "string" ? rawNote : undefined;
      const result = approveBatch(ctx.db, ctx.clock, req.currentUser!, id!, note);
      if (!result.ok) {
        res.status(result.http).json({ error: result.message });
        return;
      }
      res.json(serializeBatchDetail(ctx.db, getBatchRow(ctx.db, id!)!, req.currentUser!));
    });

    // Close: any user (techs close batches — CONTEXT.md), guarded on the
    // lifecycle and on every device being terminal.
    batches.post("/:id/close", (req, res) => {
      const id = parseBatchId(req.params.id);
      const row = id === undefined ? undefined : getBatchRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no batch with that id" });
        return;
      }
      const result = closeBatch(ctx.db, ctx.clock, req.currentUser!, id!);
      if (!result.ok) {
        res.status(result.http).json({ error: result.message });
        return;
      }
      res.json(serializeBatchDetail(ctx.db, getBatchRow(ctx.db, id!)!, req.currentUser!));
    });

    // The one note endpoint (auth/timeline.ts factory): validate → 404 →
    // transaction → recordEvent → return the serialized event.
    registerNotesRoute(batches, ctx, {
      entityType: "batch",
      notFoundMessage: "no batch with that id",
      exists: (db, id) => getBatchRow(db, id) !== undefined,
    });

    batches.get("/:id/timeline", (req, res) => {
      const id = parseBatchId(req.params.id);
      const row = id === undefined ? undefined : getBatchRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no batch with that id" });
        return;
      }
      const events = timelineEvents(ctx.db, TIMELINE_WHERE, [id, id]);
      res.json(events);
      // One immutable timeline: there are no note/event edit or delete
      // endpoints anywhere in this domain, on purpose.
    });

    api.use("/batches", batches);
    registerDeviceRoutes(api, ctx);
    registerModelRoutes(api, ctx);
  },
};
