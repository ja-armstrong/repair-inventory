import { Router } from "express";
import type { Express, Response } from "express";
import { z } from "zod";
import type { AppContext, Domain } from "../../domain.js";
import { recordEvent } from "../auth/events.js";
import { getApiRouter } from "../auth/index.js";
import { requireManager } from "../auth/session.js";
import { registerNotesRoute, timelineEvents } from "../auth/timeline.js";
import { parsePriceToCents } from "../parts/prices.js";
import { getLabelSize } from "../parts/settings.js";
import { listSkusBelowMinimum } from "../parts/stock.js";
import { listOutstandingDemandGrouped } from "./demand.js";
import { LineError, demandRefs, lineSchema, priceInput, resolveLines } from "./lines.js";
import type { LineSnapshot } from "./lines.js";
import {
  closeWithShortfall,
  ensureExpectedSerials,
  listExpectedSerials,
  receiveConsumableLine,
  receiveSerial,
} from "./receiving.js";
import {
  getPoRow,
  listPoRows,
  poDetail,
  serializePoSummary,
} from "./serialize.js";

/**
 * The purchase-orders domain (tickets 07 + 08): paperwork (create, approve,
 * track) plus the physical half (expected serials, label data, scan-to-
 * receive, auto-reservation, close-with-shortfall).
 *
 * Every timeline write goes through `recordEvent`: events are `po.created`,
 * `po.tracking_added`, `po.demand_marked`, `po.status_changed`,
 * `po.shipping_changed`, `po.part_received`, `po.consumable_received`,
 * `po.serials_assigned`, and `note.added`. The timeline is one immutable
 * chronological list, like batches'.
 */

const SHIPPING_MESSAGE =
  "shipping cost must be a non-negative amount with at most two decimal places";
const CREATE_MESSAGE =
  "a purpose, an opening note, and at least one line (SKU, quantity of at least 1, unit price) are required";
const REVISE_MESSAGE =
  "at least one line (SKU, quantity of at least 1, unit price) is required";

const trackingEntrySchema = z.object({
  carrier: z.string().trim().min(1).max(100),
  trackingNumber: z.string().trim().min(1).max(200),
});

const createPoSchema = z.object({
  purpose: z.string().trim().min(1).max(500),
  note: z.string().trim().min(1),
  sources: z.string().trim().max(500).optional(),
  shippingCost: priceInput.optional(),
  lines: z.array(lineSchema).min(1).max(200),
  tracking: z.array(trackingEntrySchema).max(50).optional(),
});

// The revise contract reuses lineSchema verbatim: a line accepted at
// creation is exactly a line accepted at revision.
const reviseLinesSchema = z.object({
  // The note is OPTIONAL (same reasoning as the approval note below): the
  // line diff itself records what changed and why is the reviser's to add.
  // When a note IS given it must be non-blank — a blank-but-present note is
  // refused loudly, never silently dropped.
  note: z.string().trim().min(1).optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

// The approval note is OPTIONAL: the sign-off is the status change itself,
// and requiring prose for every approval is friction (the same reasoning
// that made device-rejection notes optional — see
// .scratch/optional-rejection-notes/spec.md). When a note IS given it must
// be non-blank — a blank-but-present note is refused loudly, never silently
// dropped; an omitted note simply records no note in the event payload.
const approveSchema = z.object({ note: z.string().trim().min(1).optional() });
const shippingCostSchema = z.object({
  shippingCost: priceInput,
  // The note is OPTIONAL: the shipping_changed event itself records old →
  // new, so the change is never silent even noteless. Same contract as the
  // approval note — given-but-blank is refused, omitted records no note.
  note: z.string().trim().min(1).optional(),
});
const receiveSchema = z.object({ serial: z.string().trim().min(1) });
const receiveConsumableSchema = z.object({
  lineId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().min(1).max(100000),
});
const closeSchema = z.object({ note: z.string().trim().min(1) });

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function parsePoId(raw: string | string[] | undefined): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return undefined;
  }
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export const purchaseOrdersDomain: Domain = {
  name: "purchaseorders",
  register(app: Express, ctx: AppContext): void {
    const api = getApiRouter(app);
    const pos = Router();

    // ---- create -----------------------------------------------------------

    pos.post("/", (req, res) => {
      const parsed = createPoSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, CREATE_MESSAGE);
        return;
      }
      const body = parsed.data;

      const shippingCents =
        body.shippingCost === undefined ? 0 : parsePriceToCents(body.shippingCost);
      if (shippingCents === null) {
        badRequest(res, SHIPPING_MESSAGE);
        return;
      }

      // Lines reference real SKUs (catalog, ticket 03) and, when present,
      // real demand records (ticket 05's demand_records — see demand.ts for
      // the integration contract; the migration runner guarantees the
      // table, so validation is unconditional). A demand may be marked
      // ordered only when its batch is APPROVED (Open): a pre-approval
      // batch's demand is an estimate the manager has not signed off.
      // All of it — prices included — is the ONE shared per-line validation
      // (lines.ts resolveLines), the same contract the revise route runs.
      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const create = ctx.db.transaction((): number => {
        const { pricesCents: linePrices } = resolveLines(ctx.db, body.lines);
        // Sequential human numbers, like batches: PO #1, #2, ...
        const next = ctx.db
          .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM purchase_orders")
          .get() as { n: number };
        const result = ctx.db
          .prepare(
            `INSERT INTO purchase_orders
               (number, purpose, sources, shipping_cost_cents, status, created_at, created_by)
             VALUES (?, ?, ?, ?, 'Awaiting approval', ?, ?)`
          )
          .run(
            next.n,
            body.purpose,
            body.sources && body.sources.length > 0 ? body.sources : null,
            shippingCents,
            now,
            actor.id
          );
        const poId = Number(result.lastInsertRowid);

        const totalCents =
          shippingCents +
          body.lines.reduce((sum, line, index) => sum + linePrices[index] * line.quantity, 0);
        recordEvent(ctx.db, ctx.clock, {
          entityType: "po",
          entityId: poId,
          actorId: actor.id,
          action: "po.created",
          payload: {
            number: next.n,
            purpose: body.purpose,
            lineCount: body.lines.length,
            totalCents,
          },
        });
        // The required opening note is the timeline's first note.added event.
        recordEvent(ctx.db, ctx.clock, {
          entityType: "po",
          entityId: poId,
          actorId: actor.id,
          action: "note.added",
          payload: { text: body.note },
        });

        const insertLine = ctx.db.prepare(
          `INSERT INTO purchase_order_lines
             (po_id, sku_id, quantity, unit_price_cents, source, demand_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        const linkDemand = ctx.db.prepare(
          // Portable upsert (ADR-0001; review arch-E): the UNIQUE(po_id,
          // demand_id) constraint deduplicates repeated demand references
          // within one PO, so several lines may point at the same record.
          `INSERT INTO purchase_order_demand (po_id, demand_id, marked_at) VALUES (?, ?, ?)
             ON CONFLICT (po_id, demand_id) DO NOTHING`
        );
        const demandIds: number[] = [];
        body.lines.forEach((line, index) => {
          const lineDemandRefs = [
            ...(line.demandIds ?? []),
            ...(line.demandId !== undefined ? [line.demandId] : []),
          ];
          insertLine.run(
            poId,
            line.skuId,
            line.quantity,
            linePrices[index],
            line.source && line.source.length > 0 ? line.source : null,
            lineDemandRefs[0] ?? null,
            now
          );
          for (const demandId of lineDemandRefs) {
            linkDemand.run(poId, demandId, now);
            if (!demandIds.includes(demandId)) {
              demandIds.push(demandId);
            }
          }
        });
        if (demandIds.length > 0) {
          // Marking demand ordered is the whole demand integration on this
          // side: outstanding = open records minus these ids — the one
          // definition lives in batchparts/queries.ts and both demand
          // endpoints use it (final review F1).
          recordEvent(ctx.db, ctx.clock, {
            entityType: "po",
            entityId: poId,
            actorId: actor.id,
            action: "po.demand_marked",
            payload: { demandIds },
          });
        }

        const insertTracking = ctx.db.prepare(
          `INSERT INTO purchase_order_tracking
             (po_id, carrier, tracking_number, added_at, added_by)
           VALUES (?, ?, ?, ?, ?)`
        );
        for (const entry of body.tracking ?? []) {
          insertTracking.run(poId, entry.carrier, entry.trackingNumber, now, actor.id);
          recordEvent(ctx.db, ctx.clock, {
            entityType: "po",
            entityId: poId,
            actorId: actor.id,
            action: "po.tracking_added",
            payload: { carrier: entry.carrier, trackingNumber: entry.trackingNumber },
          });
        }
        return poId;
      });

      let poId: number;
      try {
        poId = create();
      } catch (error) {
        if (error instanceof LineError) {
          badRequest(res, error.message);
          return;
        }
        throw error;
      }
      res.status(201).json(poDetail(ctx.db, getPoRow(ctx.db, poId)!));
    });

    // ---- list ---------------------------------------------------------------

    pos.get("/", (_req, res) => {
      res.json(listPoRows(ctx.db).map(serializePoSummary));
    });

    // ---- the demand prompt (ticket-05 integration) --------------------------

    pos.get("/demand", (_req, res) => {
      // Grouped per SKU with a total quantity: the shop orders "5 × Screen",
      // not five individual Need to Order records. Each group carries the
      // underlying demand ids, so selecting it links them ALL to the line.
      //
      // Alongside the demand records, the prompt lists the serialized SKUs
      // whose on-hand stock sits below their minimum on-hand quantity (the
      // shared definition lives in parts/stock.ts): a prompt, not a state
      // machine — the row disappears when receiving lifts the stock to the
      // minimum, not when a PO references it.
      res.json({
        demand: listOutstandingDemandGrouped(ctx.db),
        lowStock: listSkusBelowMinimum(ctx.db),
      });
    });

    // ---- purpose/source suggestions from history ----------------------------

    pos.get("/suggestions", (_req, res) => {
      // Distinct past purposes and sources (PO-level plus per-line), freshest
      // first — free text with suggestions, never a rigid dropdown.
      const purposes = (
        ctx.db
          .prepare(
            `SELECT purpose AS value, MAX(id) AS last_id
               FROM purchase_orders
              WHERE purpose != ''
              GROUP BY purpose ORDER BY last_id DESC`
          )
          .all() as Array<{ value: string; last_id: number }>
      ).map((row) => row.value);

      const poSources = ctx.db
        .prepare(
          `SELECT sources AS value, MAX(id) AS last_id
             FROM purchase_orders
            WHERE sources IS NOT NULL AND TRIM(sources) != ''
            GROUP BY sources`
        )
        .all() as Array<{ value: string; last_id: number }>;
      const lineSources = ctx.db
        .prepare(
          `SELECT source AS value, MAX(id) AS last_id
             FROM purchase_order_lines
            WHERE source IS NOT NULL AND TRIM(source) != ''
            GROUP BY source`
        )
        .all() as Array<{ value: string; last_id: number }>;
      const merged = new Map<string, number>();
      for (const { value, last_id } of [...poSources, ...lineSources]) {
        merged.set(value, Math.max(last_id, merged.get(value) ?? 0));
      }
      const sources = [...merged.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([value]) => value);

      res.json({ purposes, sources });
    });

    // ---- detail and timeline --------------------------------------------------

    pos.get("/:id/timeline", (req, res) => {
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      res.json(timelineEvents(ctx.db, "e.entity_type = 'po' AND e.entity_id = ?", [id]));
    });

    pos.get("/:id", (req, res) => {
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      res.json(poDetail(ctx.db, row));
    });

    // ---- notes ------------------------------------------------------------------

    // The one note endpoint (auth/timeline.ts factory): validate → 404 →
    // transaction → recordEvent → return the serialized event.
    registerNotesRoute(pos, ctx, {
      entityType: "po",
      notFoundMessage: "no purchase order with that id",
      invalidIdMessage: "invalid purchase order id",
      exists: (db, id) => getPoRow(db, id) !== undefined,
    });

    // ---- tracking entries ----------------------------------------------------

    pos.post("/:id/tracking", (req, res) => {
      const parsed = trackingEntrySchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a carrier and a tracking number are required");
        return;
      }
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const add = ctx.db.transaction(() => {
        const result = ctx.db
          .prepare(
            `INSERT INTO purchase_order_tracking
               (po_id, carrier, tracking_number, added_at, added_by)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(id, parsed.data.carrier, parsed.data.trackingNumber, now, actor.id);
        recordEvent(ctx.db, ctx.clock, {
          entityType: "po",
          entityId: id,
          actorId: actor.id,
          action: "po.tracking_added",
          payload: {
            carrier: parsed.data.carrier,
            trackingNumber: parsed.data.trackingNumber,
          },
        });
        return Number(result.lastInsertRowid);
      });
      const trackingId = add();
      const entry = ctx.db
        .prepare(
          `SELECT t.id, t.carrier, t.tracking_number, t.added_at, t.added_by, u.email AS added_by_email
             FROM purchase_order_tracking t JOIN users u ON u.id = t.added_by
            WHERE t.id = ?`
        )
        .get(trackingId) as {
        id: number;
        carrier: string;
        tracking_number: string;
        added_at: string;
        added_by: number;
        added_by_email: string;
      };
      res.status(201).json({
        id: entry.id,
        carrier: entry.carrier,
        trackingNumber: entry.tracking_number,
        addedAt: entry.added_at,
        addedBy: { id: entry.added_by, email: entry.added_by_email },
      });
    });

    // ---- revise lines (Awaiting approval only) -------------------------------

    // Spec (.scratch/po-pre-approval-edits/spec.md): an unapproved PO is a
    // draft — the submitted line set REPLACES the existing one (SKUs added,
    // removed, quantities/prices adjusted), with an optional note (the line
    // diff is the record). Expected serials are assigned at approval and
    // nothing can be received while Awaiting approval, so a rewrite here can
    // never orphan receipts.
    pos.post("/:id/lines", (req, res) => {
      const parsed = reviseLinesSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, REVISE_MESSAGE);
        return;
      }
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      if (row.status !== "Awaiting approval") {
        res.status(409).json({
          error: `only a purchase order in Awaiting approval can have its lines revised — this one is ${row.status}`,
        });
        return;
      }
      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const revise = ctx.db.transaction(() => {
        // Loud, not silent: a line with received units must never be
        // rewritten (the receipts would vanish with the row). The status
        // gate above makes this unreachable today; if it ever holds, the
        // write crashes instead of hiding physical history.
        const received = ctx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM purchase_order_lines WHERE po_id = ? AND received_quantity > 0"
          )
          .get(id) as { n: number };
        if (received.n > 0) {
          throw new Error(`purchase order ${id} has received quantities but is ${row.status}`);
        }

        // Same per-line contract as creation (lines.ts) — one copy of the rule.
        const { pricesCents } = resolveLines(ctx.db, parsed.data.lines);

        const previous: LineSnapshot[] = (
          ctx.db
            .prepare(
              `SELECT l.quantity, l.unit_price_cents, l.source, s.name AS sku_name
                 FROM purchase_order_lines l JOIN skus s ON s.id = l.sku_id
                WHERE l.po_id = ? ORDER BY l.id`
            )
            .all(id) as Array<{
          quantity: number;
          unit_price_cents: number;
          source: string | null;
          sku_name: string;
        }>
        ).map((line) => ({
          sku: line.sku_name,
          quantity: line.quantity,
          unitPriceCents: line.unit_price_cents,
          source: line.source,
        }));
        const previousLinesTotalCents = previous.reduce(
          (sum, line) => sum + line.unitPriceCents * line.quantity,
          0
        );

        // Demand links are RE-DERIVED, not round-tripped: the link table is
        // PO-grain (only each line's first ref is stored on the line), so
        // per-line demand sets cannot survive a rewrite. Rule: a link stays
        // while its demand is open AND its SKU still has a line; explicit
        // refs on the submitted lines mark NEW demands ordered (validated by
        // resolveLines); everything else is released back to the outstanding
        // queue. A cancelled or fulfilled demand is pruned either way.
        const existingLinks = (
          ctx.db
            .prepare(
              `SELECT d.id, d.sku_id, d.status
                 FROM purchase_order_demand l JOIN demand_records d ON d.id = l.demand_id
                WHERE l.po_id = ?`
            )
            .all(id) as Array<{ id: number; sku_id: number; status: string }>
        );
        const existingIds = new Set(existingLinks.map((link) => link.id));
        const newRefs: number[] = [];
        for (const line of parsed.data.lines) {
          for (const demandId of demandRefs(line)) {
            if (!newRefs.includes(demandId)) {
              newRefs.push(demandId);
            }
          }
        }
        const skuWithLine = new Set(parsed.data.lines.map((line) => line.skuId));
        const kept = existingLinks
          .filter((link) => link.status === "open" && skuWithLine.has(link.sku_id))
          .map((link) => link.id);
        const finalLinks = new Set([...kept, ...newRefs]);
        const demandReleased = existingLinks
          .filter((link) => !finalLinks.has(link.id))
          .map((link) => link.id);
        const demandMarked = newRefs.filter((demandId) => !existingIds.has(demandId));

        const releaseLink = ctx.db.prepare(
          "DELETE FROM purchase_order_demand WHERE po_id = ? AND demand_id = ?"
        );
        for (const demandId of demandReleased) {
          releaseLink.run(id, demandId);
        }

        ctx.db.prepare("DELETE FROM purchase_order_lines WHERE po_id = ?").run(id);
        const insertLine = ctx.db.prepare(
          `INSERT INTO purchase_order_lines
             (po_id, sku_id, quantity, unit_price_cents, source, demand_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        const linkDemand = ctx.db.prepare(
          // Same portable upsert as creation (ADR-0001): UNIQUE(po_id,
          // demand_id) deduplicates repeated references.
          `INSERT INTO purchase_order_demand (po_id, demand_id, marked_at) VALUES (?, ?, ?)
             ON CONFLICT (po_id, demand_id) DO NOTHING`
        );
        const newLines: LineSnapshot[] = [];
        parsed.data.lines.forEach((line, index) => {
          // resolveLines asserted this SKU exists in THIS transaction; if the
          // row still cannot be read, that is an inconsistency worth crashing
          // on, never a fabricated name (review standard: loud failure).
          const sku = ctx.db.prepare("SELECT name FROM skus WHERE id = ?").get(line.skuId) as
            | { name: string }
            | undefined;
          if (!sku) {
            throw new Error(`sku ${line.skuId} vanished between validation and write on purchase order ${id}`);
          }
          newLines.push({
            sku: sku.name,
            quantity: line.quantity,
            unitPriceCents: pricesCents[index],
            source: line.source && line.source.length > 0 ? line.source : null,
          });
          const lineDemandRefs = demandRefs(line);
          insertLine.run(
            id,
            line.skuId,
            line.quantity,
            pricesCents[index],
            newLines[newLines.length - 1].source,
            lineDemandRefs[0] ?? null,
            now
          );
          for (const demandId of lineDemandRefs) {
            linkDemand.run(id, demandId, now);
          }
        });

        // The event's totals are LINES totals — shipping is separate and
        // unchanged by a revision. Named "linesTotalCents" (not "totalCents")
        // because po.created's totalCents includes shipping: one key, one
        // meaning, so a timeline reader is never comparing unlike numbers.
        const linesTotalCents = newLines.reduce(
          (sum, line) => sum + line.unitPriceCents * line.quantity,
          0
        );
        // One user action, one event: the NEW line set (the previous set
        // lives on the prior event in the chain), count/total old → new,
        // the demand-link diff, and the required note.
        recordEvent(ctx.db, ctx.clock, {
          entityType: "po",
          entityId: id,
          actorId: actor.id,
          action: "po.lines_changed",
          payload: {
            ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
            lines: newLines,
            previousLineCount: previous.length,
            previousLinesTotalCents,
            linesTotalCents,
            demandMarked,
            demandReleased,
          },
        });
      });
      try {
        revise();
      } catch (error) {
        if (error instanceof LineError) {
          badRequest(res, error.message);
          return;
        }
        throw error;
      }
      res.json(poDetail(ctx.db, getPoRow(ctx.db, id)!));
    });

    // ---- delete a draft (Awaiting approval only) -----------------------------

    // Spec (.scratch/po-pre-approval-edits/spec.md): a mistaken draft PO is
    // deleted outright. Nothing physical ever referenced it — expected
    // serials are assigned at approval and nothing can be received while
    // Awaiting approval — so the rows, the demand links, and the timeline go
    // together. HARD delete, like the SKU delete's treatment of pristine
    // SKUs: no soft "voided" status for list queries and expense reporting
    // to filter forever. No note: nothing survives to carry one — the status
    // gate IS the record. Sequential numbers are human labels (MAX+1), so a
    // deleted draft's number is reusable.
    pos.delete("/:id", (req, res) => {
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      if (row.status !== "Awaiting approval") {
        res.status(409).json({
          error: `only a purchase order in Awaiting approval can be deleted — this one is ${row.status}`,
        });
        return;
      }
      // Children first, then the events, then the row: safe under FK
      // enforcement, and atomic in one transaction.
      const del = ctx.db.transaction(() => {
        ctx.db.prepare("DELETE FROM purchase_order_demand WHERE po_id = ?").run(id);
        ctx.db.prepare("DELETE FROM purchase_order_lines WHERE po_id = ?").run(id);
        ctx.db.prepare("DELETE FROM purchase_order_tracking WHERE po_id = ?").run(id);
        ctx.db
          .prepare("DELETE FROM events WHERE entity_type = 'po' AND entity_id = ?")
          .run(id);
        ctx.db.prepare("DELETE FROM purchase_orders WHERE id = ?").run(id);
      });
      del();
      // Deleted demand links simply cease to exist — the outstanding queue
      // (open demand minus link ids) shows those records again with no
      // extra write; the demands themselves were never touched.
      res.json({ deleted: id });
    });

    // ---- manager approval: Awaiting approval -> In-transit --------------------

    pos.post("/:id/approve", requireManager, (req, res) => {
      const parsed = approveSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "the approval note, when given, cannot be blank");
        return;
      }
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      if (row.status !== "Awaiting approval") {
        res.status(409).json({
          error: `only a purchase order in Awaiting approval can be approved — this one is ${row.status}`,
        });
        return;
      }
      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const approve = ctx.db.transaction(() => {
        ctx.db
          .prepare(
            "UPDATE purchase_orders SET status = 'In-transit', approved_at = ?, approved_by = ? WHERE id = ?"
          )
          .run(now, actor.id, id);
        recordEvent(ctx.db, ctx.clock, {
          entityType: "po",
          entityId: id,
          actorId: actor.id,
          action: "po.status_changed",
          // An omitted note stays omitted (JSON.stringify drops the key) —
          // the same payload shape the optional device-decision note uses.
          payload: { from: "Awaiting approval", to: "In-transit", note: parsed.data.note },
        });
        // Pre-assign expected serials so labels can print before anything arrives.
        const assigned = ensureExpectedSerials(ctx.db, id, now);
        if (assigned > 0) {
          recordEvent(ctx.db, ctx.clock, {
            entityType: "po",
            entityId: id,
            actorId: actor.id,
            action: "po.serials_assigned",
            payload: { count: assigned },
          });
        }
      });
      approve();
      res.json(poDetail(ctx.db, getPoRow(ctx.db, id)!));
    });

    // ---- manager shipping-cost edit (any status except Closed) --------------

    // Ticket: shipping cost is set at creation but the real freight number is
    // known when the package ships — after approval. One explicit route (no
    // general PO PATCH): the contract stays narrow, and the value, gate, and
    // note rule are stated here rather than implied by a generic update.
    pos.post("/:id/shipping-cost", requireManager, (req, res) => {
      const parsed = shippingCostSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a shipping cost is required (a note, when given, cannot be blank)");
        return;
      }
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      // Same parser as creation: dollars at the edge, integer cents in
      // storage, negatives and >2-decimal inputs refused — matching the
      // column's CHECK (shipping_cost_cents >= 0).
      const cents = parsePriceToCents(parsed.data.shippingCost);
      if (cents === null) {
        badRequest(res, SHIPPING_MESSAGE);
        return;
      }
      // Closed is terminal: the PO is then the historical record of what was
      // spent, so its shipping cost can no longer move. Every earlier status
      // is fair game — In-transit and Partially received edits are the point.
      if (row.status === "Closed") {
        res.status(409).json({
          error: "a Closed purchase order can no longer change its shipping cost",
        });
        return;
      }
      const actor = req.currentUser!;
      const apply = ctx.db.transaction(() => {
        ctx.db
          .prepare("UPDATE purchase_orders SET shipping_cost_cents = ? WHERE id = ?")
          .run(cents, id);
        // Old → new, plus the note when one was given — one event in the
        // same immutable timeline the notes live in — nothing edits or
        // deletes it.
        recordEvent(ctx.db, ctx.clock, {
          entityType: "po",
          entityId: id,
          actorId: actor.id,
          action: "po.shipping_changed",
          payload: {
            from: row.shipping_cost_cents,
            to: cents,
            ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
          },
        });
      });
      apply();
      // No total math here: poDetail sums lines + shipping_cost_cents
      // (serialize.ts) — the one definition of a PO total. Expense reporting
      // reads this same column, so the edit flows through it; no parallel
      // number is written anywhere.
      res.json(poDetail(ctx.db, getPoRow(ctx.db, id)!));
    });

    // ---- labels (expected serials for the print view) -----------------------

    pos.get("/:id/labels", (req, res) => {
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      if (row.status === "Awaiting approval") {
        res.status(409).json({
          error: "approve the purchase order before printing labels — expected serials are assigned on approval",
        });
        return;
      }
      // WHY this write in a read route: the invariant is "an approved PO has
      // its expected serials". Approval assigns them, but a PO approved
      // before this code shipped would otherwise print zero labels — silent
      // wrong output. The ensure reconciles that gap, once, with an event;
      // it is idempotent and refuses nothing new.
      const ensure = ctx.db.transaction(() => {
        const assigned = ensureExpectedSerials(ctx.db, id, ctx.clock.now().toISOString());
        if (assigned > 0) {
          recordEvent(ctx.db, ctx.clock, {
            entityType: "po",
            entityId: id,
            actorId: req.currentUser!.id,
            action: "po.serials_assigned",
            payload: { count: assigned },
          });
        }
      });
      ensure();
      // Label size comes from the manager-editable settings keys (sixteenths
      // of an inch, seeded by migration 0009); the print view derives CSS.
      // Read through parts/settings.ts getLabelSize — the one reader shared
      // with the intake label sheet (ticket 13).
      const size = getLabelSize(ctx.db);
      const labels = listExpectedSerials(ctx.db, id).map((entry) => ({
        serial: entry.serial,
        skuId: entry.sku.id,
        skuName: entry.sku.name,
        lineId: entry.lineId,
        received: entry.received,
      }));
      res.json({
        poId: row.id,
        number: row.number,
        purpose: row.purpose,
        label: size,
        labels,
      });
    });

    // ---- scan-to-receive ----------------------------------------------------

    pos.post("/:id/receive", (req, res) => {
      const parsed = receiveSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a serial is required");
        return;
      }
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      const actor = req.currentUser!;
      const run = ctx.db.transaction(() => receiveSerial(ctx.db, ctx.clock, row, actor.id, parsed.data.serial));
      let result: ReturnType<typeof receiveSerial>;
      try {
        result = run();
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("failed to reserve")) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }
      if ("kind" in result) {
        const status =
          result.kind === "already_received" || result.kind === "bad_status" ? 409 : 400;
        res.status(status).json({ error: result.message });
        return;
      }
      res.json({
        ...result,
        purchaseOrder: poDetail(ctx.db, getPoRow(ctx.db, id)!),
      });
    });

    pos.post("/:id/receive-consumable", (req, res) => {
      const parsed = receiveConsumableSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a line id and a whole-number quantity of at least 1 are required");
        return;
      }
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      const actor = req.currentUser!;
      const run = ctx.db.transaction(() =>
        receiveConsumableLine(
          ctx.db,
          ctx.clock,
          row,
          actor.id,
          parsed.data.lineId,
          parsed.data.quantity
        )
      );
      const result = run();
      if ("kind" in result) {
        const status = result.kind === "bad_status" ? 409 : 400;
        res.status(status).json({ error: result.message });
        return;
      }
      res.json({
        ...result,
        purchaseOrder: poDetail(ctx.db, getPoRow(ctx.db, id)!),
      });
    });

    // ---- close with shortfall -----------------------------------------------

    pos.post("/:id/close", (req, res) => {
      const parsed = closeSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a note is required — closing with a shortfall needs a reason");
        return;
      }
      const id = parsePoId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid purchase order id");
        return;
      }
      const row = getPoRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no purchase order with that id" });
        return;
      }
      const actor = req.currentUser!;
      const run = ctx.db.transaction(() =>
        closeWithShortfall(ctx.db, ctx.clock, row, actor.id, parsed.data.note)
      );
      const result = run();
      if ("kind" in result) {
        res.status(409).json({ error: result.message });
        return;
      }
      res.json(poDetail(ctx.db, getPoRow(ctx.db, id)!));
    });

    api.use("/purchase-orders", pos);
  },
};
