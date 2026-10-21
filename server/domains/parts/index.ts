import { Router } from "express";
import type { Express, Response } from "express";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { AppContext, Domain } from "../../domain.js";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";
import { getApiRouter } from "../auth/index.js";
import { requireManager } from "../auth/session.js";
import { timelineFor } from "../auth/timeline.js";
import { deviceLabel } from "../batchparts/attach.js";
import { formatCents, parsePriceToCents } from "./prices.js";
import { resolveEffectivePriceCents, setPartPrice } from "./effective-price.js";
import { intakeParts } from "./intake.js";
import { normalizeSerial } from "./serials.js";
import { countAvailable } from "./stock.js";
import { changePartStatus, PART_STATUS_LABELS, type PartStatus } from "./status.js";
import {
  getLabelSize,
  getSetting,
  getSettingInt,
  getSettingRow,
  listSettings,
  SETTING_DEFINITIONS,
  validateSettingValue,
} from "./settings.js";

/**
 * The parts domain (ticket 03): the SKU catalog, intake of serialized parts
 * (ticket 13: migration and salvage through parts/intake.ts — the one writer
 * of non-PO part rows), part lifecycle statuses, price expiry with the
 * manager's price-audit queue, and the app settings that configure the
 * intervals.
 *
 * Vocabulary per CONTEXT.md: a **SKU** is a kind of part (serialized or
 * consumable); a **Serialized Part** is a physical unit with a
 * system-assigned **Serial**; statuses are Available, Reserved, Unavailable,
 * RMA, Damaged by Tech, Buyback, and In-Transit (attached to an open
 * outbound order — only the order domains move a part there, ticket 29).
 * Consumables are cost-only — no stock rows, no
 * counting, no statuses. Every part records its **Intake Source**
 * (purchase-order, migration, salvage) on the row and in its timeline.
 *
 * Every timeline write goes through `recordEvent` (the auth domain's shared
 * write path): events are `sku.created`, `sku.renamed`, `sku.price_changed`,
 * `sku.price_refreshed`, `sku.source_changed` (ticket 11 — the default
 * source link, a plain field: no note required, but the change is on the
 * timeline), `part.added`, `part.status_changed`,
 * `part.price_changed` (ticket 23), and `setting.updated`.
 *
 * Part-status writes route through `parts/status.ts` (ticket 14) — the one
 * module owning the status vocabulary, the guarded transition rules, and the
 * `part.status_changed` event. This endpoint is the bare "a human changes a
 * status" door; batch reservations, RMA complete, and audit settlement have
 * their own doors into the same module.
 */

export type { PartStatus } from "./status.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SkuKind = "serialized" | "consumable";

interface SkuRow {
  id: number;
  name: string;
  price_cents: number;
  kind: SkuKind;
  buybackable: number;
  created_at: string;
  price_updated_at: string;
  /** Ticket 11: the SKU's default source link (free text); NULL = none. */
  default_source_url: string | null;
  /** Minimum on-hand quantity: serialized SKUs only; 0 = no minimum. */
  min_on_hand: number;
}

interface PartRow {
  id: number;
  sku_id: number;
  serial: string;
  status: PartStatus;
  last_counted_at: string | null;
  created_at: string;
  intake_source: string | null;
  /** The part's own price override in cents; NULL = use the SKU price (ticket 23). */
  price_cents: number | null;
}

const priceInput = z.union([z.string(), z.number()]);

const createSkuSchema = z.object({
  name: z.string().trim().min(1),
  price: priceInput,
  kind: z.enum(["serialized", "consumable"]),
  // Ticket 27 (CONTEXT.md: Buybackable): serialized SKUs only — refused on
  // consumables exactly like the PATCH path.
  buybackable: z.boolean().optional(),
  // Ticket 11: the default source link is free text (no supplier entity,
  // no URL validation — whatever the tech pastes is what the prefill
  // carries; clickability is decided at read time). An empty string means
  // "no link" and is stored as NULL, so there is one representation of
  // "none".
  defaultSourceUrl: z.string().trim().max(2000).optional(),
  // Minimum on-hand quantity (serialized SKUs only): the smallest on-hand
  // stock the shop wants on the shelf; the PO form prompts with the
  // shortfall. Absent means 0 — "no minimum" — never a guess.
  minOnHand: z.coerce.number().int().min(0).optional(),
});

const patchSkuSchema = z.object({
  name: z.string().trim().min(1).optional(),
  price: priceInput.optional(),
  // Kind changes are corrections (e.g. "entered as consumable by mistake").
  // They require a note: the kind decides whether serialized stock can exist
  // under this SKU at all, so the change must carry its reason on the timeline.
  kind: z.enum(["serialized", "consumable"]).optional(),
  // Ticket 27 (CONTEXT.md: Buybackable): serialized SKUs only; a change
  // requires a note (it flips which removal destination parts of this SKU
  // default to, and which parts the supplier program will take).
  buybackable: z.boolean().optional(),
  // Ticket 11: same contract as create — free text, empty string = clear.
  defaultSourceUrl: z.string().trim().max(2000).optional(),
  // Minimum on-hand quantity: same contract as create; a change is recorded
  // on the timeline as sku.min_on_hand_changed.
  minOnHand: z.coerce.number().int().min(0).optional(),
  note: z.string().trim().min(1).max(2000).optional(),
});

const intakeSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("migration"),
    // Optional: a bare migration intake is one part. (z.coerce.number()
    // alone would coerce a missing quantity to NaN and fail — .optional()
    // short-circuits before the coercion.)
    quantity: z.coerce.number().int().min(1).max(200).optional(),
    // Explicit, never defaulted: whether these parts were physically counted
    // decides whether the first audit demands them (spec story 77).
    counted: z.boolean(),
    note: z.string().trim().max(2000).optional(),
    // The part's own price (ticket 23): dollars at the edge, cents in
    // storage. Optional — absent means "use the SKU's current price".
    price: priceInput.optional(),
  }),
  z.object({
    source: z.literal("salvage"),
    quantity: z.literal(1).optional(),
    // The provenance note IS salvage intake (what it came off, why it exists).
    note: z.string().trim().min(1).max(2000),
    price: priceInput.optional(),
  }),
]);

const statusChangeSchema = z.object({
  status: z.enum([
    "available",
    "reserved",
    "unavailable",
    "rma",
    "damaged_by_tech",
    "buyback",
  ]),
  note: z.string().trim().min(1),
});

const priceChangeSchema = z.object({
  price: priceInput,
  note: z.string().trim().min(1),
});

const priceRefreshSchema = z.object({
  price: priceInput.optional(),
});

const patchSettingSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number()]),
});

const PRICE_MESSAGE = "price must be a non-negative amount with at most two decimal places";

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function parseId(raw: string | string[] | undefined): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return undefined;
  }
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function getSkuRow(db: Database.Database, id: number): SkuRow | undefined {
  return db
    .prepare(
      "SELECT id, name, price_cents, kind, buybackable, created_at, price_updated_at, default_source_url, min_on_hand FROM skus WHERE id = ?"
    )
    .get(id) as SkuRow | undefined;
}

function getPartRow(db: Database.Database, id: number): PartRow | undefined {
  return db
    .prepare(
      "SELECT id, sku_id, serial, status, last_counted_at, created_at, intake_source, price_cents FROM serialized_parts WHERE id = ?"
    )
    .get(id) as PartRow | undefined;
}

function getPartBySerial(db: Database.Database, serial: string): PartRow | undefined {
  return db
    .prepare(
      "SELECT id, sku_id, serial, status, last_counted_at, created_at, intake_source, price_cents FROM serialized_parts WHERE serial = ?"
    )
    .get(serial) as PartRow | undefined;
}

interface SerializedSku {
  id: number;
  name: string;
  kind: SkuKind;
  buybackable: boolean;
  price: string;
  priceCents: number;
  createdAt: string;
  priceUpdatedAt: string;
  priceExpiresAt: string;
  priceStale: boolean;
  availableCount: number | null;
  /** Ticket 11: the default source link, verbatim free text; null = none. */
  defaultSourceUrl: string | null;
  /** Minimum on-hand quantity; consumables carry 0 (the field is serialized-only). */
  minOnHand: number;
}

/**
 * A SKU at the API edge: the price formatted in dollars plus the raw cents,
 * and the price-expiry state computed against the `price_expiry_days`
 * setting and the injectable clock. Staleness is a warning — it never blocks
 * use.
 */
function serializeSku(db: Database.Database, row: SkuRow, now: Date): SerializedSku {
  const expiresAt = new Date(
    Date.parse(row.price_updated_at) + getSettingInt(db, "price_expiry_days") * DAY_MS
  );
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    // Ticket 27 (CONTEXT.md: Buybackable): serialized SKUs only — enforced
    // at the write seams; surfaced here for the SKU page's checkbox.
    buybackable: row.buybackable === 1,
    price: formatCents(row.price_cents),
    priceCents: row.price_cents,
    createdAt: row.created_at,
    priceUpdatedAt: row.price_updated_at,
    priceExpiresAt: expiresAt.toISOString(),
    priceStale: now.getTime() >= expiresAt.getTime(),
    availableCount: row.kind === "serialized" ? countAvailable(db, row.id) : null,
    defaultSourceUrl: row.default_source_url,
    minOnHand: row.min_on_hand,
  };
}

/**
 * A part at the API edge. The price fields are the Part Price (ticket 23):
 * `priceCents`/`price` are the EFFECTIVE price — the part's own override, or
 * the SKU's current price when it has none — while `overrideCents` exposes
 * the override itself (null when the part follows the SKU) and
 * `priceOverridden` says which case it is. Callers pass the SKU's current
 * price; the override-vs-SKU resolution itself lives only in
 * parts/effective-price.ts.
 */
function serializePart(row: PartRow, skuPriceCents: number) {
  const effectiveCents = resolveEffectivePriceCents(row.price_cents, skuPriceCents);
  return {
    id: row.id,
    skuId: row.sku_id,
    serial: row.serial,
    status: row.status,
    statusLabel: PART_STATUS_LABELS[row.status],
    lastCountedAt: row.last_counted_at,
    createdAt: row.created_at,
    // Intake Source (ticket 13): how this unit entered inventory. The column
    // is nullable only as a schema artifact (migration 0013); the write seams
    // always set it, and a NULL is surfaced verbatim instead of guessed at.
    intakeSource: row.intake_source,
    priceCents: effectiveCents,
    price: formatCents(effectiveCents),
    overrideCents: row.price_cents,
    priceOverridden: row.price_cents !== null,
  };
}

function partDetail(db: Database.Database, clock: Clock, part: PartRow) {
  const skuRow = getSkuRow(db, part.sku_id) as SkuRow;
  return {
    ...serializePart(part, skuRow.price_cents),
    sku: serializeSku(db, skuRow, clock.now()),
    events: timelineFor(db, "part", part.id),
  };
}

export const partsDomain: Domain = {
  name: "parts",
  register(app: Express, ctx: AppContext) {
    const api = getApiRouter(app);

    const skus = Router();
    const parts = Router();
    const settings = Router();

    // ---- SKUs -------------------------------------------------------------

    skus.get("/", (req, res) => {
      const now = ctx.clock.now();
      const rows = ctx.db
        .prepare(
          "SELECT id, name, price_cents, kind, buybackable, created_at, price_updated_at, default_source_url, min_on_hand FROM skus ORDER BY LOWER(name), id"
        )
        .all() as SkuRow[];
      res.json(rows.map((row) => serializeSku(ctx.db, row, now)));
    });

    skus.post("/", (req, res) => {
      const parsed = createSkuSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a name, price, and kind (serialized or consumable) are required");
        return;
      }
      const priceCents = parsePriceToCents(parsed.data.price);
      if (priceCents === null) {
        badRequest(res, PRICE_MESSAGE);
        return;
      }
      if (parsed.data.buybackable === true && parsed.data.kind === "consumable") {
        badRequest(res, "buybackable is for serialized SKUs only (consumables have no units to sell back)");
        return;
      }
      // Minimum on-hand (CONTEXT.md: SKU): a minimum describes shelf stock,
      // and a consumable has no units — refused exactly like buybackable.
      if (
        parsed.data.minOnHand !== undefined &&
        parsed.data.minOnHand !== 0 &&
        parsed.data.kind === "consumable"
      ) {
        badRequest(res, "minimum on-hand is for serialized SKUs only (consumables have no units to stock)");
        return;
      }
      // Ticket 11: "" after the schema's trim IS "no link" — stored as NULL
      // so the column has exactly one representation of "none".
      const sourceUrl =
        parsed.data.defaultSourceUrl !== undefined && parsed.data.defaultSourceUrl !== ""
          ? parsed.data.defaultSourceUrl
          : null;
      const actor = req.currentUser!;
      const now = ctx.clock.now();
      const create = ctx.db.transaction(() => {
        const result = ctx.db
          .prepare(
            "INSERT INTO skus (name, price_cents, kind, buybackable, created_at, price_updated_at, default_source_url, min_on_hand) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            parsed.data.name,
            priceCents,
            parsed.data.kind,
            parsed.data.buybackable === true ? 1 : 0,
            now.toISOString(),
            now.toISOString(),
            sourceUrl,
            parsed.data.minOnHand ?? 0
          );
        const id = Number(result.lastInsertRowid);
        recordEvent(ctx.db, ctx.clock, {
          entityType: "sku",
          entityId: id,
          actorId: actor.id,
          action: "sku.created",
          payload: {
            name: parsed.data.name,
            priceCents,
            kind: parsed.data.kind,
            ...(parsed.data.buybackable === true ? { buybackable: true } : {}),
            ...(sourceUrl !== null ? { defaultSourceUrl: sourceUrl } : {}),
            ...(parsed.data.minOnHand !== undefined && parsed.data.minOnHand !== 0
              ? { minOnHand: parsed.data.minOnHand }
              : {}),
          },
        });
        return id;
      });
      const id = create();
      res.status(201).json(serializeSku(ctx.db, getSkuRow(ctx.db, id) as SkuRow, ctx.clock.now()));
    });

    skus.get("/:id", (req, res) => {
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid SKU id");
        return;
      }
      const row = getSkuRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no SKU with that id" });
        return;
      }
      const partRows =
        row.kind === "serialized"
          ? (ctx.db
              .prepare(
                "SELECT id, sku_id, serial, status, last_counted_at, created_at, intake_source, price_cents FROM serialized_parts WHERE sku_id = ? ORDER BY id"
              )
              .all(id) as PartRow[])
          : [];
      res.json({
        ...serializeSku(ctx.db, row, ctx.clock.now()),
        parts: partRows.map((partRow) => serializePart(partRow, row.price_cents)),
        events: timelineFor(ctx.db, "sku", id),
      });
    });

    skus.patch("/:id", (req, res) => {
      const parsed = patchSkuSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "provide a name, a price, and/or a kind (with a note) to update");
        return;
      }
      const { name, price, kind, note, buybackable, defaultSourceUrl, minOnHand } = parsed.data;
      if (
        name === undefined &&
        price === undefined &&
        kind === undefined &&
        buybackable === undefined &&
        defaultSourceUrl === undefined &&
        minOnHand === undefined
      ) {
        badRequest(
          res,
          "provide a name, a price, a kind, a buybackable flag, a default source link, and/or a minimum on-hand quantity (with a note where required) to update"
        );
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid SKU id");
        return;
      }
      const row = getSkuRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no SKU with that id" });
        return;
      }
      const priceCents = price !== undefined ? parsePriceToCents(price) : undefined;
      if (priceCents === null) {
        badRequest(res, PRICE_MESSAGE);
        return;
      }
      // Kind-change guards run before the transaction opens: a refusal here
      // must not leave a half-open transaction, and an early return inside a
      // better-sqlite3 transaction callback would return from the callback,
      // not from this handler.
      const kindChanges = kind !== undefined && kind !== row.kind;
      if (kindChanges && !note) {
        badRequest(res, "changing a SKU's kind requires a note explaining the correction");
        return;
      }
      if (kindChanges && row.kind === "serialized" && kind === "consumable") {
        const { n } = ctx.db
          .prepare("SELECT COUNT(*) AS n FROM serialized_parts WHERE sku_id = ?")
          .get(id) as { n: number };
        if (n > 0) {
          res.status(409).json({
            error: `${n} serialized part${n === 1 ? "" : "s"} exist${n === 1 ? "s" : ""} under this SKU — they cannot become consumable. Re-home or write them off first.`,
          });
          return;
        }
      }
      // Ticket 27 (CONTEXT.md: Buybackable): the flag exists to route
      // serialized units into the supplier program — a consumable has no
      // units to sell back, so it can never be buybackable.
      if (buybackable === true && row.kind === "consumable") {
        res.status(409).json({
          error: `${row.name} is a consumable SKU — buybackable is for serialized SKUs only (consumables have no units to sell back)`,
        });
        return;
      }
      if (kindChanges && kind === "consumable" && row.buybackable === 1) {
        res.status(409).json({
          error: `${row.name} is buybackable — turn that off before making the SKU consumable`,
        });
        return;
      }
      // Minimum on-hand: same serialized-only rule as buybackable. Setting it
      // on a consumable is refused; a serialized SKU carrying a minimum must
      // return it to 0 before it can change kind (the minimum would otherwise
      // keep prompting the PO form for stock a consumable can never have).
      if (minOnHand !== undefined && minOnHand !== 0 && row.kind === "consumable") {
        res.status(409).json({
          error: `${row.name} is a consumable SKU — minimum on-hand is for serialized SKUs only (consumables have no units to stock)`,
        });
        return;
      }
      if (kindChanges && kind === "consumable" && row.min_on_hand > 0) {
        res.status(409).json({
          error: `${row.name} has a minimum on-hand of ${row.min_on_hand} — set it to 0 before making the SKU consumable`,
        });
        return;
      }
      const minOnHandChanges = minOnHand !== undefined && minOnHand !== row.min_on_hand;
      const buybackableChanges = buybackable !== undefined && buybackable !== (row.buybackable === 1);
      if (buybackableChanges && !note) {
        badRequest(res, "changing a SKU's buybackable flag requires a note explaining the change");
        return;
      }
      // Ticket 11: like create, "" after the schema's trim IS "no link" —
      // normalized to NULL here so the column keeps one representation of
      // "none" and an unchanged untouched field never counts as a change.
      const sourceUrl =
        defaultSourceUrl !== undefined && defaultSourceUrl !== ""
          ? defaultSourceUrl
          : defaultSourceUrl === undefined
            ? undefined
            : null;
      const sourceUrlChanges = sourceUrl !== undefined && sourceUrl !== row.default_source_url;
      const actor = req.currentUser!;
      const now = ctx.clock.now();
      const update = ctx.db.transaction(() => {
        if (name !== undefined && name !== row.name) {
          ctx.db.prepare("UPDATE skus SET name = ? WHERE id = ?").run(name, id);
          recordEvent(ctx.db, ctx.clock, {
            entityType: "sku",
            entityId: id,
            actorId: actor.id,
            action: "sku.renamed",
            payload: { from: row.name, to: name },
          });
        }
        if (priceCents !== undefined && priceCents !== row.price_cents) {
          ctx.db
            .prepare("UPDATE skus SET price_cents = ?, price_updated_at = ? WHERE id = ?")
            .run(priceCents, now.toISOString(), id);
          recordEvent(ctx.db, ctx.clock, {
            entityType: "sku",
            entityId: id,
            actorId: actor.id,
            action: "sku.price_changed",
            payload: { from: row.price_cents, to: priceCents },
          });
        }
        if (kindChanges) {
          // consumable → serialized is always safe (no units exist to
          // orphan); the serialized → consumable stock guard already ran.
          ctx.db.prepare("UPDATE skus SET kind = ? WHERE id = ?").run(kind, id);
          recordEvent(ctx.db, ctx.clock, {
            entityType: "sku",
            entityId: id,
            actorId: actor.id,
            action: "sku.kind_changed",
            payload: { from: row.kind, to: kind, note },
          });
        }
        if (buybackableChanges) {
          ctx.db.prepare("UPDATE skus SET buybackable = ? WHERE id = ?").run(buybackable ? 1 : 0, id);
          recordEvent(ctx.db, ctx.clock, {
            entityType: "sku",
            entityId: id,
            actorId: actor.id,
            action: "sku.buybackable_changed",
            payload: {
              from: row.buybackable === 1,
              to: buybackable,
              note,
            },
          });
        }
        if (sourceUrlChanges) {
          // A plain field, not a guarded one: the default link is a
          // convenience prefill, never a lock, so unlike kind/buybackable it
          // needs no note — but the change still lands on the timeline.
          ctx.db.prepare("UPDATE skus SET default_source_url = ? WHERE id = ?").run(sourceUrl, id);
          recordEvent(ctx.db, ctx.clock, {
            entityType: "sku",
            entityId: id,
            actorId: actor.id,
            action: "sku.source_changed",
            payload: { from: row.default_source_url, to: sourceUrl },
          });
        }
        if (minOnHandChanges) {
          // Same shape as the default link: a plain replenishment setting
          // (like the price, no note required), recorded on the timeline so
          // the PO prompt's history is traceable.
          ctx.db.prepare("UPDATE skus SET min_on_hand = ? WHERE id = ?").run(minOnHand, id);
          recordEvent(ctx.db, ctx.clock, {
            entityType: "sku",
            entityId: id,
            actorId: actor.id,
            action: "sku.min_on_hand_changed",
            payload: { from: row.min_on_hand, to: minOnHand },
          });
        }
      });
      update();
      res.json(serializeSku(ctx.db, getSkuRow(ctx.db, id) as SkuRow, ctx.clock.now()));
    });

    // ---- SKU deletion ------------------------------------------------------
    //
    // Deletion is for corrections (a mis-typed SKU nobody has used yet). A SKU
    // carrying any history — serialized stock, consumable usage, demand, or a
    // PO line — is refused loudly with the counts: those rows are the immutable
    // audit trail the rest of the system points at. A pristine SKU is deleted
    // with a required note; the sku.deleted event outlives the row so the
    // timeline still says what existed and why it went away.
    skus.delete("/:id", (req, res) => {
      const parsed = z.object({ note: z.string().trim().min(1).max(2000) }).safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "deleting a SKU requires a note explaining why");
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid SKU id");
        return;
      }
      const row = getSkuRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no SKU with that id" });
        return;
      }
      const counts = {
        parts: (
          ctx.db.prepare("SELECT COUNT(*) AS n FROM serialized_parts WHERE sku_id = ?").get(id) as {
            n: number;
          }
        ).n,
        usage: (
          ctx.db.prepare("SELECT COUNT(*) AS n FROM device_consumables WHERE sku_id = ?").get(id) as {
            n: number;
          }
        ).n,
        demand: (
          ctx.db.prepare("SELECT COUNT(*) AS n FROM demand_records WHERE sku_id = ?").get(id) as {
            n: number;
          }
        ).n,
        poLines: (
          ctx.db
            .prepare("SELECT COUNT(*) AS n FROM purchase_order_lines WHERE sku_id = ?")
            .get(id) as { n: number }
        ).n,
      };
      const blockerLabels: Record<keyof typeof counts, string> = {
        parts: "serialized part",
        usage: "consumable usage record",
        demand: "demand record",
        poLines: "purchase order line",
      };
      const blockers = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([what, n]) => `${n} ${blockerLabels[what as keyof typeof counts]}${n === 1 ? "" : "s"}`);
      if (blockers.length > 0) {
        res.status(409).json({
          error: `this SKU cannot be deleted: ${blockers.join(", ")} reference it. History is immutable — re-home or write off the references instead.`,
        });
        return;
      }
      const actor = req.currentUser!;
      const del = ctx.db.transaction(() => {
        recordEvent(ctx.db, ctx.clock, {
          entityType: "sku",
          entityId: id,
          actorId: actor.id,
          action: "sku.deleted",
          payload: { name: row.name, note: parsed.data.note },
        });
        ctx.db.prepare("DELETE FROM skus WHERE id = ?").run(id);
      });
      del();
      res.json({ ok: true });
    });

    // ---- intake of serialized parts (ticket 13) ---------------------------
    //
    // One intake door for everything that is not a PO receipt. The source
    // discriminates the flow:
    // - migration — bulk-add pre-existing shelf stock; `counted` is the
    //   tech's explicit "physically counted now" confirmation (no default:
    //   whether the first audit demands these parts is not something to
    //   guess). The counted refresh goes through the shared counting seam
    //   (audits/counting.ts via parts/intake.ts), so audit due-ness treats
    //   it as a real count.
    // - salvage — exactly one part with a required provenance note.
    skus.post("/:id/parts", (req, res) => {
      const parsed = intakeSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(
          res,
          'intake needs a source: { source: "migration", quantity (1–200), counted (bool) } or { source: "salvage", note (provenance, required) }'
        );
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid SKU id");
        return;
      }
      const row = getSkuRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no SKU with that id" });
        return;
      }
      if (row.kind !== "serialized") {
        badRequest(
          res,
          "consumable SKUs are tracked for cost only — they have no serialized stock to add"
        );
        return;
      }
      const input = parsed.data;
      const priceCents = input.price !== undefined ? parsePriceToCents(input.price) : undefined;
      if (priceCents === null) {
        badRequest(res, PRICE_MESSAGE);
        return;
      }
      const created = ctx.db.transaction(() =>
        intakeParts(ctx.db, ctx.clock, req.currentUser!, {
          skuId: id,
          source: input.source,
          quantity: input.quantity ?? 1,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.source === "migration" ? { counted: input.counted } : {}),
          ...(priceCents !== undefined ? { priceCents } : {}),
        })
      )();
      res.status(201).json({
        parts: created.map((part) => ({
          ...serializePart(getPartRow(ctx.db, part.id) as PartRow, row.price_cents),
          // The arrival record (ticket 10): which demand took the part,
          // where it landed, and any loud refusal from the auto-reserve
          // seam. The device label is presentation — batchparts' shared
          // helper (model + best identifier), same vocabulary the PO display
          // uses for "Fulfills demand".
          reserved: part.reserved,
          reservationRefusal: part.reservationRefusal,
          demandId: part.demandId,
          batchId: part.batchId,
          batchNumber: part.batchNumber,
          deviceId: part.deviceId,
          deviceLabel: part.deviceId !== null ? deviceLabel(ctx.db, part.deviceId) : null,
        })),
      });
    });

    // ---- the manager's price-audit refresh -------------------------------

    skus.post("/:id/price-refresh", requireManager, (req, res) => {
      const parsed = priceRefreshSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        badRequest(res, PRICE_MESSAGE);
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid SKU id");
        return;
      }
      const row = getSkuRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no SKU with that id" });
        return;
      }
      const newCents =
        parsed.data.price !== undefined ? parsePriceToCents(parsed.data.price) : row.price_cents;
      if (newCents === null) {
        badRequest(res, PRICE_MESSAGE);
        return;
      }
      const actor = req.currentUser!;
      const now = ctx.clock.now();
      const refresh = ctx.db.transaction(() => {
        ctx.db
          .prepare("UPDATE skus SET price_cents = ?, price_updated_at = ? WHERE id = ?")
          .run(newCents, now.toISOString(), id);
        recordEvent(ctx.db, ctx.clock, {
          entityType: "sku",
          entityId: id,
          actorId: actor.id,
          action: "sku.price_refreshed",
          payload: { from: row.price_cents, to: newCents },
        });
      });
      refresh();
      res.json(serializeSku(ctx.db, getSkuRow(ctx.db, id) as SkuRow, ctx.clock.now()));
    });

    // ---- serialized parts: detail and status transitions ------------------

    // ---- part label sheets (ticket 13) -------------------------------------
    //
    // Label data for ANY set of serialized parts. The PO labels endpoint
    // (purchaseorders) covers a PO's expected serials, including ones not yet
    // received; this one covers parts that exist — migration and salvage
    // intake print from it, and so can any future selection. The label size
    // comes from the same manager-editable settings the PO sheet uses
    // (settings.ts getLabelSize — the one reader).
    //
    // Registration order (see the route-order contract below): this must be
    // registered BEFORE GET /:serial, which would otherwise match "labels"
    // as a serial.
    parts.get("/labels", (req, res) => {
      const raw = req.query.ids;
      if (typeof raw !== "string" || raw.trim() === "") {
        badRequest(res, "a comma-separated ids query parameter is required");
        return;
      }
      const ids = [...new Set(raw.split(",").map((value) => Number(value.trim())))];
      if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        badRequest(res, "ids must be positive whole numbers, comma-separated");
        return;
      }
      const placeholders = ids.map(() => "?").join(", ");
      const rows = ctx.db
        .prepare(
          `SELECT p.id, p.serial, p.sku_id, s.name AS sku_name
             FROM serialized_parts p JOIN skus s ON s.id = p.sku_id
            WHERE p.id IN (${placeholders})
            ORDER BY p.id`
        )
        .all(...ids) as Array<{ id: number; serial: string; sku_id: number; sku_name: string }>;
      // Loud on a partial match: a label sheet missing a part the caller asked
      // for is silent wrong output — the missing id is named, not skipped.
      const found = new Set(rows.map((row) => row.id));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) {
        res.status(404).json({ error: `no serialized part with id ${missing[0]}` });
        return;
      }
      res.json({
        label: getLabelSize(ctx.db),
        labels: rows.map((row) => ({
          id: row.id,
          serial: row.serial,
          skuId: row.sku_id,
          skuName: row.sku_name,
        })),
      });
    });

    // Route-order contract (review minor): this route matches ONE segment
    // only — /api/parts/:serial — so two-segment subpaths under the same
    // prefix (batchparts' GET /:serial/attachments, on its own /parts
    // router mounted later in bootstrap) fall through to it naturally.
    // Any future parts route longer than one segment must either live in
    // this router ABOVE these two entries or in a later-mounted router;
    // registering a one-segment GET after this one would be shadowed by it.
    parts.get("/:serial", (req, res) => {
      const serial = normalizeSerial(req.params.serial);
      const part = getPartBySerial(ctx.db, serial);
      if (!part) {
        res.status(404).json({ error: `no serialized part with serial ${serial}` });
        return;
      }
      res.json(partDetail(ctx.db, ctx.clock, part));
    });

    parts.post("/:serial/status", (req, res) => {
      const parsed = statusChangeSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a status and a note are required — every transition needs a reason");
        return;
      }
      const serial = normalizeSerial(req.params.serial);
      const part = getPartBySerial(ctx.db, serial);
      if (!part) {
        res.status(404).json({ error: `no serialized part with serial ${serial}` });
        return;
      }
      // Through the part-status module (ticket 14): the guarded transition
      // rules (Reserved belongs to the Batch; an in-transit RMA order owns
      // its parts' statuses until Complete) and the part.status_changed
      // event live there — this endpoint is only the HTTP edge.
      const result = changePartStatus(ctx.db, ctx.clock, req.currentUser!, {
        partId: part.id,
        to: parsed.data.status,
        note: parsed.data.note,
        via: "part_endpoint",
      });
      if (!result.ok) {
        res.status(result.http).json({ error: result.message });
        return;
      }
      res.json(partDetail(ctx.db, ctx.clock, getPartRow(ctx.db, part.id) as PartRow));
    });

    // ---- the part's own price (ticket 23) ----------------------------------
    //
    // The Part Price re-price door (CONTEXT.md: Part Price). The note is the
    // change's record; the locking rules, the snapshot sync onto the active
    // attachment, and the Open-batch amendment live in ONE place —
    // parts/effective-price.ts setPartPrice — and refusals name the batch.
    parts.post("/:serial/price", (req, res) => {
      const parsed = priceChangeSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a price and a note are required — the note is the price change's record");
        return;
      }
      const overrideCents = parsePriceToCents(parsed.data.price);
      if (overrideCents === null) {
        badRequest(res, PRICE_MESSAGE);
        return;
      }
      const serial = normalizeSerial(req.params.serial);
      const part = getPartBySerial(ctx.db, serial);
      if (!part) {
        res.status(404).json({ error: `no serialized part with serial ${serial}` });
        return;
      }
      const result = setPartPrice(ctx.db, ctx.clock, req.currentUser!, {
        partId: part.id,
        overrideCents,
        note: parsed.data.note,
      });
      if (!result.ok) {
        res.status(result.http).json({ error: result.message });
        return;
      }
      res.json(partDetail(ctx.db, ctx.clock, getPartRow(ctx.db, part.id) as PartRow));
    });

    // ---- the price-audit queue (manager-only) -----------------------------

    api.get("/price-audit", requireManager, (_req, res) => {
      const now = ctx.clock.now();
      const days = getSettingInt(ctx.db, "price_expiry_days");
      const rows = ctx.db
        .prepare(
          "SELECT id, name, price_cents, kind, buybackable, created_at, price_updated_at, default_source_url, min_on_hand FROM skus ORDER BY price_updated_at, id"
        )
        .all() as SkuRow[];
      const skusWithExpiry = rows.map((row) => ({
        row,
        expiresAt: Date.parse(row.price_updated_at) + days * DAY_MS,
      }));
      const stale = skusWithExpiry
        .filter(({ expiresAt }) => now.getTime() >= expiresAt)
        .map(({ row, expiresAt }) => ({
          ...serializeSku(ctx.db, row, now),
          daysStale: Math.floor((now.getTime() - expiresAt) / DAY_MS),
        }));
      res.json({ priceExpiryDays: days, skus: stale });
    });

    // ---- app settings ------------------------------------------------------

    settings.get("/", (_req, res) => {
      res.json(listSettings(ctx.db));
    });

    settings.patch("/", requireManager, (req, res) => {
      const parsed = patchSettingSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a settings key and value are required");
        return;
      }
      const { key, value } = parsed.data;
      const definition = SETTING_DEFINITIONS.find((candidate) => candidate.key === key);
      if (!definition) {
        badRequest(res, `unknown setting: ${key}`);
        return;
      }
      const validated = validateSettingValue(definition, value);
      if ("error" in validated) {
        badRequest(res, validated.error);
        return;
      }
      const numeric = validated.value;
      const previous = getSetting(ctx.db, key);
      const actor = req.currentUser!;
      const update = ctx.db.transaction(() => {
        // rows are seeded by migration 0003; this insert only guards a
        // database that predates the seed
        const existing = getSettingRow(ctx.db, key);
        if (!existing) {
          const inserted = ctx.db
            .prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .run(key, definition.default);
          recordEvent(ctx.db, ctx.clock, {
            entityType: "setting",
            entityId: Number(inserted.lastInsertRowid),
            actorId: null,
            action: "setting.created",
            payload: { key, value: definition.default },
          });
        }
        ctx.db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(String(numeric), key);
        const row = getSettingRow(ctx.db, key) as { id: number };
        recordEvent(ctx.db, ctx.clock, {
          entityType: "setting",
          entityId: row.id,
          actorId: actor.id,
          action: "setting.updated",
          payload: { key, from: previous, to: String(numeric) },
        });
      });
      update();
      res.json(listSettings(ctx.db));
    });

    api.use("/skus", skus);
    api.use("/parts", parts);
    api.use("/settings", settings);
  },
};
