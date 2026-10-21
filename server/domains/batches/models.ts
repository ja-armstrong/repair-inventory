import { Router } from "express";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { AppContext } from "../../domain.js";
import { recordEvent } from "../auth/events.js";
import type { CurrentUser } from "../auth/session.js";

/**
 * The maintained Model list (CONTEXT.md): techs extend it on the fly from
 * the device form, and it will drive compatible part-SKU suggestions in a
 * later ticket. Models are never edited or removed — only added.
 */

export interface ModelRow {
  id: number;
  name: string;
  created_at: string;
  created_by: number | null;
  created_by_email: string | null;
}

const MODEL_BASE_SELECT = `
  SELECT m.id, m.name, m.created_at, m.created_by, u.email AS created_by_email
    FROM device_models m LEFT JOIN users u ON u.id = m.created_by
`;

const MODEL_SELECT = `${MODEL_BASE_SELECT} ORDER BY LOWER(m.name), m.id`;

function listModels(db: Database.Database): ModelRow[] {
  return db.prepare(MODEL_SELECT).all() as ModelRow[];
}

/**
 * Case-insensitive name match (LOWER comparison — portable per ADR-0001),
 * matching the convention used for serials and SKUs: "iphone 15" and
 * "iPhone 15" are the same model, so a re-add in a different case returns
 * the existing row instead of creating a near-duplicate.
 */
function findModelByName(db: Database.Database, name: string): ModelRow | undefined {
  return db
    .prepare(`${MODEL_BASE_SELECT} WHERE LOWER(m.name) = LOWER(?)`)
    .get(name) as ModelRow | undefined;
}

function findModelById(db: Database.Database, id: number): ModelRow | undefined {
  return db.prepare(`${MODEL_BASE_SELECT} WHERE m.id = ?`).get(id) as ModelRow | undefined;
}

function serializeModel(row: ModelRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    createdBy: row.created_by === null ? null : { id: row.created_by, email: row.created_by_email },
  };
}

/**
 * Adds a model to the list, recording a `model.created` event. Exact-name
 * matches return the existing row WITHOUT a new event. Callers translate a
 * `null` name (empty/whitespace) into their own validation error.
 */
export function addModel(
  db: Database.Database,
  ctx: AppContext,
  actor: CurrentUser,
  name: string
): ModelRow {
  const existing = findModelByName(db, name);
  if (existing) {
    return existing;
  }
  const insert = ctx.db.transaction((): ModelRow => {
    const result = db
      .prepare("INSERT INTO device_models (name, created_at, created_by) VALUES (?, ?, ?)")
      .run(name, ctx.clock.now().toISOString(), actor.id);
    const id = Number(result.lastInsertRowid);
    recordEvent(db, ctx.clock, {
      entityType: "model",
      entityId: id,
      actorId: actor.id,
      action: "model.created",
      payload: { name },
    });
    return findModelById(db, id) as ModelRow;
  });
  return insert();
}

const createModelSchema = z.object({
  name: z.string().trim().min(1, "a model name is required"),
});

export function registerModelRoutes(api: Router, ctx: AppContext): void {
  const models = Router();

  models.get("/", (_req, res) => {
    res.json(listModels(ctx.db).map(serializeModel));
  });

  models.post("/", (req, res) => {
    const parsed = createModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "a model name is required" });
      return;
    }
    const existing = findModelByName(ctx.db, parsed.data.name);
    if (existing) {
      res.status(409).json({ error: `a model named "${parsed.data.name}" already exists` });
      return;
    }
    const row = addModel(ctx.db, ctx, req.currentUser!, parsed.data.name);
    res.status(201).json(serializeModel(findModelById(ctx.db, row.id) as ModelRow));
  });

  api.use("/models", models);
}
