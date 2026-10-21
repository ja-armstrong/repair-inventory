import { Router } from "express";
import type { Express, Response } from "express";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { AppContext, Domain } from "../../domain.js";
import { recordEvent } from "../auth/events.js";
import { getApiRouter } from "../auth/index.js";
import { requireManager } from "../auth/session.js";
import { registerNotesRoute, timelineFor } from "../auth/timeline.js";
import { normalizeSerial } from "../parts/serials.js";
import {
  changePartStatus,
  openInTransitOrder,
  outboundOrderLabel,
  partStatusLabel,
} from "../parts/status.js";
import { formatCents, parsePriceToCents } from "../parts/prices.js";

/**
 * The RMA domain (ticket 09, reworked by ticket 29): shipments of
 * RMA-status parts back to a vendor.
 *
 * Vocabulary per CONTEXT.md: an **RMA Order** is created with a required
 * opening note and is In-Transit from creation (no approval gate); scanning
 * (typing) a serial attaches an RMA-status part and moves it to the shared
 * **In-Transit** part status — physically gone with the shipment, visible at
 * a glance. On Complete — any user — every part on the order becomes
 * **Unavailable**, credited or RMA-rejected alike, with the per-part
 * disposition, credit value (integer cents, entered BY HAND when the vendor
 * accepts — spec ticket 29), and note recorded for the recovery report
 * (ticket 12 reads them through GET /api/rma-credits).
 *
 * While the order is open, its recovered value is unknown, so the summary
 * carries an ESTIMATE: 50% of the parts' effective-price sum (CONTEXT.md:
 * RMA Order estimate). It is display-only — reports never read it.
 *
 * Status transitions happen here, in this domain's own transactional code —
 * never through the parts domain's bare status endpoint — so each transition
 * lands atomically with its events. Events go to BOTH timelines: the order's
 * (rma.*) and the part's (part.*), all through the shared `recordEvent`.
 *
 * Money is reused from the parts domain's prices module: integer cents in
 * storage, dollars only at the edges.
 */

type RmaOrderStatus = "in_transit" | "complete";
type Disposition = "credited" | "rejected";

// CONTEXT.md (RMA Order): the estimated recovery of an open RMA order is
// 50% of its parts' price sum — the vendor-acceptance discount, empirically.
const RMA_ESTIMATE_RATIO = 0.5;

const RMA_STATUS_LABELS: Record<RmaOrderStatus, string> = {
  in_transit: "In-Transit",
  complete: "Complete",
};

const DISPOSITION_LABELS: Record<Disposition, string> = {
  credited: "Credited",
  rejected: "RMA-rejected",
};

const priceInput = z.union([z.string(), z.number()]);

const createSchema = z.object({ note: z.string().trim().min(1) });

const scanSchema = z.object({ serial: z.string().trim().min(1) });

const completeSchema = z.object({
  note: z.string().trim().min(1),
  parts: z
    .array(
      z.object({
        serial: z.string().trim().min(1),
        disposition: z.enum(["credited", "rejected"]),
        credit: priceInput.optional(),
        note: z.string().trim().min(1),
      }),
    )
    .optional(),
});

const PRICE_MESSAGE = "credit must be a non-negative amount with at most two decimal places";

interface RmaOrderRow {
  id: number;
  number: number;
  status: RmaOrderStatus;
  created_at: string;
  created_by: number;
  completed_at: string | null;
}

interface RmaOrderPartRow {
  id: number;
  rma_order_id: number;
  part_id: number;
  added_at: string;
  added_by: number;
  disposition: Disposition | null;
  credit_cents: number | null;
  disposition_note: string | null;
  settled_at: string | null;
}

interface OrderPartView {
  part_id: number;
  serial: string;
  sku_id: number;
  sku_name: string;
  effective_price_cents: number;
  added_at: string;
  added_by_email: string;
  disposition: Disposition | null;
  credit_cents: number | null;
  disposition_note: string | null;
  settled_at: string | null;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function parseId(raw: string): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function getOrderRow(db: Database.Database, id: number): RmaOrderRow | undefined {
  return db
    .prepare("SELECT id, number, status, created_at, created_by, completed_at FROM rma_orders WHERE id = ?")
    .get(id) as RmaOrderRow | undefined;
}

interface OrderTotals {
  partCount: number;
  creditCents: number;
  /** Sum of the order parts' EFFECTIVE prices (override ?? SKU) — the estimate base. */
  partsValueCents: number;
}

function orderTotals(db: Database.Database, orderId: number): OrderTotals {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS part_count,
              COALESCE(SUM(CASE WHEN rp.credit_cents IS NOT NULL THEN rp.credit_cents ELSE 0 END), 0) AS credit_cents,
              COALESCE(SUM(COALESCE(p.price_cents, s.price_cents)), 0) AS parts_value_cents
         FROM rma_order_parts rp
         JOIN serialized_parts p ON p.id = rp.part_id
         JOIN skus s ON s.id = p.sku_id
        WHERE rp.rma_order_id = ?`
    )
    .get(orderId) as { part_count: number; credit_cents: number; parts_value_cents: number };
  return { partCount: row.part_count, creditCents: row.credit_cents, partsValueCents: row.parts_value_cents };
}

const ORDER_PARTS_SELECT = `
  SELECT rp.part_id, p.serial, p.sku_id, s.name AS sku_name,
         COALESCE(p.price_cents, s.price_cents) AS effective_price_cents,
         rp.added_at, u.email AS added_by_email,
         rp.disposition, rp.credit_cents, rp.disposition_note, rp.settled_at
    FROM rma_order_parts rp
    JOIN serialized_parts p ON p.id = rp.part_id
    JOIN skus s ON s.id = p.sku_id
    LEFT JOIN users u ON u.id = rp.added_by
   WHERE rp.rma_order_id = ?
   ORDER BY rp.id
`;

function listOrderParts(db: Database.Database, orderId: number): OrderPartView[] {
  return db.prepare(ORDER_PARTS_SELECT).all(orderId) as OrderPartView[];
}

function serializeOrderPart(row: OrderPartView) {
  return {
    partId: row.part_id,
    serial: row.serial,
    skuId: row.sku_id,
    skuName: row.sku_name,
    // The part's effective price (override ?? SKU) — the estimate's unit.
    priceCents: row.effective_price_cents,
    price: formatCents(row.effective_price_cents),
    addedAt: row.added_at,
    addedByEmail: row.added_by_email,
    disposition: row.disposition,
    dispositionLabel: row.disposition ? DISPOSITION_LABELS[row.disposition] : null,
    creditCents: row.credit_cents,
    credit: row.credit_cents === null ? null : formatCents(row.credit_cents),
    dispositionNote: row.disposition_note,
    settledAt: row.settled_at,
  };
}

function serializeOrderSummary(db: Database.Database, row: RmaOrderRow) {
  const creator = db.prepare("SELECT email FROM users WHERE id = ?").get(row.created_by) as {
    email: string;
  };
  const totals = orderTotals(db, row.id);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    statusLabel: RMA_STATUS_LABELS[row.status],
    createdAt: row.created_at,
    createdByEmail: creator.email,
    completedAt: row.completed_at,
    ...totals,
    // CONTEXT.md (RMA Order): the estimated recovery of an OPEN order is 50%
    // of its parts' price sum. Display-only; the settled credits are the
    // real revenue record.
    estimatedValueCents: Math.round(totals.partsValueCents * RMA_ESTIMATE_RATIO),
  };
}

function serializeOrderDetail(db: Database.Database, row: RmaOrderRow) {
  return {
    ...serializeOrderSummary(db, row),
    parts: listOrderParts(db, row.id).map(serializeOrderPart),
    events: timelineFor(db, "rma", row.id),
  };
}

/** The open (In-Transit) order a part is attached to, if any. */
function openOrderForPart(db: Database.Database, partId: number): { id: number; number: number } | undefined {
  return db
    .prepare(
      `SELECT o.id, o.number
         FROM rma_order_parts rp JOIN rma_orders o ON o.id = rp.rma_order_id
        WHERE rp.part_id = ? AND o.status = 'in_transit'`
    )
    .get(partId) as { id: number; number: number } | undefined;
}

function getPartBySerial(db: Database.Database, serial: string): { id: number; status: string } | undefined {
  return db
    .prepare("SELECT id, status FROM serialized_parts WHERE serial = ?")
    .get(serial) as { id: number; status: string } | undefined;
}

export const rmaDomain: Domain = {
  name: "rma",
  register(app: Express, ctx: AppContext) {
    const api = getApiRouter(app);
    const rmaOrders = Router();

    // ---- creation (any user; required opening note) -----------------------

    rmaOrders.post("/", (req, res) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "an opening note is required");
        return;
      }
      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const create = ctx.db.transaction((): number => {
        // Sequential human numbers: #1, #2, ... — batches-style, displayed "#N".
        const next = ctx.db
          .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM rma_orders")
          .get() as { n: number };
        const result = ctx.db
          .prepare("INSERT INTO rma_orders (number, status, created_at, created_by, completed_at) VALUES (?, 'in_transit', ?, ?, NULL)")
          .run(next.n, now, actor.id);
        const id = Number(result.lastInsertRowid);
        recordEvent(ctx.db, ctx.clock, {
          entityType: "rma",
          entityId: id,
          actorId: actor.id,
          action: "rma.created",
          payload: { number: next.n },
        });
        // The required opening note is the timeline's first note.added event.
        recordEvent(ctx.db, ctx.clock, {
          entityType: "rma",
          entityId: id,
          actorId: actor.id,
          action: "note.added",
          payload: { text: parsed.data.note },
        });
        return id;
      });
      const id = create();
      res.status(201).json(serializeOrderDetail(ctx.db, getOrderRow(ctx.db, id) as RmaOrderRow));
    });

    rmaOrders.get("/", (_req, res) => {
      const rows = ctx.db
        .prepare("SELECT id, number, status, created_at, created_by, completed_at FROM rma_orders ORDER BY number DESC")
        .all() as RmaOrderRow[];
      res.json(rows.map((row) => serializeOrderSummary(ctx.db, row)));
    });

    rmaOrders.get("/:id", (req, res) => {
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid RMA order id");
        return;
      }
      const row = getOrderRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no RMA order with that id" });
        return;
      }
      res.json(serializeOrderDetail(ctx.db, row));
    });

    // ---- notes (immutable, user-stamped, merged into the timeline) -------

    // The one note endpoint (auth/timeline.ts factory): validate → 404 →
    // transaction → recordEvent → return the serialized event.
    registerNotesRoute(rmaOrders, ctx, {
      entityType: "rma",
      notFoundMessage: "no RMA order with that id",
      invalidIdMessage: "invalid RMA order id",
      exists: (db, id) => getOrderRow(db, id) !== undefined,
    });

    rmaOrders.get("/:id/timeline", (req, res) => {
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid RMA order id");
        return;
      }
      const row = getOrderRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no RMA order with that id" });
        return;
      }
      res.json(timelineFor(ctx.db, "rma", id));
      // One immutable timeline: there are no note/event edit or delete
      // endpoints anywhere in this domain, on purpose.
    });

    // ---- scan-to-add (the scanner types a serial; no note needed) --------

    rmaOrders.post("/:id/parts", (req, res) => {
      const parsed = scanSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a serial is required");
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid RMA order id");
        return;
      }
      const order = getOrderRow(ctx.db, id);
      if (!order) {
        res.status(404).json({ error: "no RMA order with that id" });
        return;
      }
      if (order.status === "complete") {
        res.status(409).json({
          error: `RMA order #${order.number} is complete — its parts are settled and can no longer be added`,
        });
        return;
      }
      const serial = normalizeSerial(parsed.data.serial);
      const part = getPartBySerial(ctx.db, serial);
      if (!part) {
        res.status(404).json({ error: `no serialized part with serial ${serial}` });
        return;
      }
      const attached = openOrderForPart(ctx.db, part.id);
      if (attached) {
        res.status(409).json({
          error:
            attached.id === order.id
              ? `${serial} is already on this RMA order (#${order.number})`
              : `${serial} is already on RMA order #${attached.number} — a part can be on only one open RMA order`,
        });
        return;
      }
      // An In-Transit part is physically gone with another shipment (ticket
      // 29) — say so with the order that owns it, not the bare status.
      const inTransitOn = openInTransitOrder(ctx.db, part.id);
      if (inTransitOn) {
        res.status(409).json({
          error: `${serial} is in transit on ${outboundOrderLabel(inTransitOn.kind)} #${inTransitOn.number} — a part can be on only one open order`,
        });
        return;
      }
      if (part.status !== "rma") {
        res.status(409).json({
          error: `${serial} is ${partStatusLabel(part.status)} — only RMA-status parts can be added to an RMA order`,
        });
        return;
      }
      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const add = ctx.db.transaction((): void => {
        ctx.db
          .prepare(
            "INSERT INTO rma_order_parts (rma_order_id, part_id, added_at, added_by) VALUES (?, ?, ?, ?)"
          )
          .run(order.id, part.id, now, actor.id);
        // Ticket 29: the scan itself moves the part RMA → In-Transit through
        // the guarded transition, so inventory reads "gone with the shipment"
        // at a glance; both timelines record the attachment.
        const moved = changePartStatus(ctx.db, ctx.clock, actor, {
          partId: part.id,
          to: "in_transit",
          note: `Scanned onto RMA order #${order.number}`,
          via: "order_scan",
          expectedFrom: "rma",
          payload: { rmaOrderId: order.id, rmaNumber: order.number },
        });
        if (!moved.ok) {
          throw new Error(`RMA scan could not move part ${serial} to In-Transit: ${moved.message}`);
        }
        recordEvent(ctx.db, ctx.clock, {
          entityType: "rma",
          entityId: order.id,
          actorId: actor.id,
          action: "rma.part_added",
          payload: { serial },
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "part",
          entityId: part.id,
          actorId: actor.id,
          action: "part.added_to_rma",
          payload: { rmaOrderId: order.id, rmaNumber: order.number },
        });
      });
      add();
      res.status(201).json(serializeOrderDetail(ctx.db, getOrderRow(ctx.db, order.id) as RmaOrderRow));
    });

    // ---- Complete (any user; required note; per-part disposition) --------

    rmaOrders.post("/:id/complete", (req, res) => {
      const parsed = completeSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(
          res,
          "a completion note and a disposition (credited or rejected) with a note for every part are required"
        );
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid RMA order id");
        return;
      }
      const order = getOrderRow(ctx.db, id);
      if (!order) {
        res.status(404).json({ error: "no RMA order with that id" });
        return;
      }
      if (order.status === "complete") {
        res.status(409).json({ error: `RMA order #${order.number} is already complete` });
        return;
      }

      const entries = parsed.data.parts ?? [];
      const orderParts = listOrderParts(ctx.db, order.id);
      if (orderParts.length === 0) {
        badRequest(res, "an RMA order with no parts can't be completed — scan parts onto it first");
        return;
      }

      // Every entry must name a part on the order, exactly once.
      const serialsOnOrder = orderParts.map((part) => part.serial);
      const bySerial = new Map(entries.map((entry) => [normalizeSerial(entry.serial), entry]));
      const seen = new Set<string>();
      for (const entry of entries) {
        const serial = normalizeSerial(entry.serial);
        if (seen.has(serial)) {
          badRequest(res, `${serial} appears more than once — each part gets exactly one disposition`);
          return;
        }
        seen.add(serial);
      }
      const unknown = [...bySerial.keys()].filter((serial) => !serialsOnOrder.includes(serial));
      if (unknown.length > 0) {
        badRequest(
          res,
          `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not on RMA order #${order.number}`
        );
        return;
      }
      const missing = serialsOnOrder.filter((serial) => !bySerial.has(serial));
      if (missing.length > 0) {
        badRequest(
          res,
          `every part on the order needs a disposition — missing: ${missing.join(", ")}`
        );
        return;
      }

      // Money at the edge: parse each credit to integer cents, and refuse
      // credits on rejected parts (rejected carries no value).
      const credits = new Map<string, number>();
      for (const entry of entries) {
        if (entry.disposition === "rejected") {
          if (entry.credit !== undefined) {
            badRequest(res, `a rejected part takes no credit value (${normalizeSerial(entry.serial)})`);
            return;
          }
          continue;
        }
        if (entry.credit === undefined) {
          badRequest(
            res,
            `a credit value is required for a credited part (${normalizeSerial(entry.serial)})`
          );
          return;
        }
        const cents = parsePriceToCents(entry.credit);
        if (cents === null) {
          badRequest(res, PRICE_MESSAGE);
          return;
        }
        credits.set(normalizeSerial(entry.serial), cents);
      }

      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const complete = ctx.db.transaction((): void => {
        for (const orderPart of orderParts) {
          const entry = bySerial.get(orderPart.serial)!;
          const creditCents = entry.disposition === "credited" ? credits.get(orderPart.serial)! : null;
          // The order's timeline: the per-part settlement...
          recordEvent(ctx.db, ctx.clock, {
            entityType: "rma",
            entityId: order.id,
            actorId: actor.id,
            action: "rma.part_settled",
            payload: {
              serial: orderPart.serial,
              disposition: entry.disposition,
              ...(creditCents !== null ? { creditCents } : {}),
              note: entry.note,
            },
          });
          // ...and the part's own status: EVERY part becomes Unavailable —
          // credited or rejected alike — through the part-status module
          // (ticket 14), guarded on the In-Transit status the scan gave the
          // part while its order is in transit (ticket 29).
          const settled = changePartStatus(ctx.db, ctx.clock, actor, {
            partId: orderPart.part_id,
            to: "unavailable",
            note: entry.note,
            via: "rma_complete",
            expectedFrom: "in_transit",
            payload: {
              rmaOrderId: order.id,
              rmaNumber: order.number,
              disposition: entry.disposition,
              ...(creditCents !== null ? { creditCents } : {}),
            },
          });
          if (!settled.ok) {
            throw new Error(
              `RMA completion could not settle part ${orderPart.serial}: ${settled.message}`
            );
          }
          ctx.db
            .prepare(
              `UPDATE rma_order_parts
                  SET disposition = ?, credit_cents = ?, disposition_note = ?, settled_at = ?
                WHERE rma_order_id = ? AND part_id = ?`
            )
            .run(
              entry.disposition,
              creditCents,
              entry.note,
              now,
              order.id,
              orderPart.part_id
            );
        }
        // The completion note, then the transition itself.
        recordEvent(ctx.db, ctx.clock, {
          entityType: "rma",
          entityId: order.id,
          actorId: actor.id,
          action: "note.added",
          payload: { text: parsed.data.note },
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "rma",
          entityId: order.id,
          actorId: actor.id,
          action: "rma.status_changed",
          payload: { from: "in_transit", to: "complete" },
        });
        ctx.db
          .prepare("UPDATE rma_orders SET status = 'complete', completed_at = ? WHERE id = ?")
          .run(now, order.id);
      });
      complete();
      res.json(serializeOrderDetail(ctx.db, getOrderRow(ctx.db, order.id) as RmaOrderRow));
    });

    api.use("/rma-orders", rmaOrders);

    // ---- the RMA-parts pool for assembly ----------------------------------
    //
    // Ticket 29: the pool is unscanned RMA parts PLUS the parts already In-
    // Transit on an open RMA order (they show with their order link, because
    // an In-Transit part's identity-as-a-shipment-member lives in this
    // domain's tables, not in its bare status).
    api.get("/rma-parts", (_req, res) => {
      const rows = ctx.db
        .prepare(
          `SELECT p.id, p.serial, p.sku_id, s.name AS sku_name,
                  o.id AS rma_order_id, o.number AS rma_number
             FROM serialized_parts p
             JOIN skus s ON s.id = p.sku_id
             LEFT JOIN rma_orders o
                   ON o.status = 'in_transit'
                  AND EXISTS (SELECT 1 FROM rma_order_parts rp
                               WHERE rp.rma_order_id = o.id AND rp.part_id = p.id)
            WHERE p.status = 'rma'
               OR (p.status = 'in_transit' AND o.id IS NOT NULL)
            ORDER BY p.id`
        )
        .all() as Array<{
        id: number;
        serial: string;
        sku_id: number;
        sku_name: string;
        rma_order_id: number | null;
        rma_number: number | null;
      }>;
      res.json(
        rows.map((row) => ({
          id: row.id,
          serial: row.serial,
          skuId: row.sku_id,
          skuName: row.sku_name,
          rmaOrderId: row.rma_order_id,
          rmaNumber: row.rma_number,
        })),
      );
    });

    // ---- the recovery-report query (ticket 12 consumes this) -------------

    api.get("/rma-credits", requireManager, (req, res) => {
      const from = typeof req.query.from === "string" && req.query.from !== "" ? req.query.from : null;
      const to = typeof req.query.to === "string" && req.query.to !== "" ? req.query.to : null;
      const clauses: string[] = ["o.status = 'complete'"];
      const params: unknown[] = [];
      if (from !== null) {
        clauses.push("o.completed_at >= ?");
        params.push(from);
      }
      if (to !== null) {
        clauses.push("o.completed_at <= ?");
        params.push(to);
      }
      const orders = ctx.db
        .prepare(
          `SELECT o.id, o.number, o.completed_at,
                  COUNT(rp.id) AS part_count,
                  COALESCE(SUM(CASE WHEN rp.credit_cents IS NOT NULL THEN rp.credit_cents ELSE 0 END), 0) AS credit_cents,
                  SUM(CASE WHEN rp.disposition = 'credited' THEN 1 ELSE 0 END) AS credited_parts,
                  SUM(CASE WHEN rp.disposition = 'rejected' THEN 1 ELSE 0 END) AS rejected_parts
             FROM rma_orders o
             LEFT JOIN rma_order_parts rp ON rp.rma_order_id = o.id
            WHERE ${clauses.join(" AND ")}
            GROUP BY o.id
            ORDER BY o.number`
        )
        .all(...params) as Array<{
        id: number;
        number: number;
        completed_at: string;
        part_count: number;
        credit_cents: number;
        credited_parts: number | null;
        rejected_parts: number | null;
      }>;
      res.json({
        from,
        to,
        totalCreditCents: orders.reduce((sum, order) => sum + order.credit_cents, 0),
        creditedParts: orders.reduce((sum, order) => sum + (order.credited_parts ?? 0), 0),
        rejectedParts: orders.reduce((sum, order) => sum + (order.rejected_parts ?? 0), 0),
        orders: orders.map((order) => ({
          id: order.id,
          number: order.number,
          completedAt: order.completed_at,
          partCount: order.part_count,
          creditCents: order.credit_cents,
        })),
      });
    });
  },
};
