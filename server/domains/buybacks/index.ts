import { Router } from "express";
import type { Express, Response } from "express";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { AppContext, Domain } from "../../domain.js";
import { recordEvent } from "../auth/events.js";
import { getApiRouter } from "../auth/index.js";
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
 * The buybacks domain (ticket 27; the order-level settlement is the
 * buyback-order-value spec): shipments of Buyback-status parts to a
 * supplier's buyback program — "an RMA order that earns money" (CONTEXT.md:
 * Buyback Order).
 *
 * The structure mirrors the RMA domain deliberately: an order is created
 * with a required opening note and is In-Transit from creation (no approval
 * gate); scanning (typing) a serial attaches a Buyback-status part and moves
 * it to the shared **In-Transit** part status — physically gone with the
 * shipment, visible at a glance. On Complete — any user, required note —
 * the WHOLE ORDER is settled with ONE hand-entered value (the recovery
 * revenue, the lump sum the supplier paid): no per-part dispositions, no
 * per-part prices. Every part on the order simply becomes **Unavailable** —
 * `buyback_order_parts` is the attachment record (which parts shipped); the
 * order carries the money.
 *
 * While the order is open, its recovered value is unknown, so the summary
 * carries an ESTIMATE: 10% of the parts' effective-price sum (CONTEXT.md:
 * Buyback Order estimate). It is display-only — reports never read it.
 *
 * Status transitions happen here, in this domain's own transactional code —
 * never through the parts domain's bare status endpoint — so each transition
 * lands atomically with its events. The bare endpoint instead refuses to
 * touch a part attached to an in-transit order (the same guard RMA has, in
 * parts/status.ts). Events go to BOTH timelines: the order's (buyback.*)
 * and the part's (part.*), all through the shared `recordEvent`.
 *
 * Money is reused from the parts domain's prices module: integer cents in
 * storage, dollars only at the edges.
 */

export type BuybackOrderStatus = "in_transit" | "complete";

export const BUYBACK_STATUS_LABELS: Record<BuybackOrderStatus, string> = {
  in_transit: "In-Transit",
  complete: "Complete",
};

// CONTEXT.md (Buyback Order): the estimated recovery of an open buyback
// order is 10% of its parts' price sum — buyback programs pay little.
const BUYBACK_ESTIMATE_RATIO = 0.1;

const priceInput = z.union([z.string(), z.number()]);

const createSchema = z.object({ note: z.string().trim().min(1) });

const scanSchema = z.object({ serial: z.string().trim().min(1) });

// The order-level settlement: one note, one value for the whole shipment.
const completeSchema = z.object({
  note: z.string().trim().min(1),
  orderValue: priceInput,
});

// The pool override (CONTEXT.md: Buybackable — "a tech may override with a
// note"): move a pooled part out before it is scanned onto an order. The
// part-status module owns the rules (note required, no Reserved part, no
// in-transit-order part); this endpoint is only the HTTP edge.
const overrideSchema = z.object({
  destination: z.enum(["available", "rma", "damaged_by_tech", "unavailable"]),
  note: z.string().trim().min(1),
});

const PRICE_MESSAGE = "the order's value must be a non-negative amount with at most two decimal places";

interface BuybackOrderRow {
  id: number;
  number: number;
  status: BuybackOrderStatus;
  created_at: string;
  created_by: number;
  completed_at: string | null;
  order_value_cents: number | null;
}

interface OrderPartView {
  part_id: number;
  serial: string;
  sku_id: number;
  sku_name: string;
  effective_price_cents: number;
  added_at: string;
  added_by_email: string;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function parseId(raw: string): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function getOrderRow(db: Database.Database, id: number): BuybackOrderRow | undefined {
  return db
    .prepare(
      "SELECT id, number, status, created_at, created_by, completed_at, order_value_cents FROM buyback_orders WHERE id = ?"
    )
    .get(id) as BuybackOrderRow | undefined;
}

interface OrderTotals {
  partCount: number;
  /** The hand-entered order value — set only by Complete, NULL while open. */
  orderValueCents: number | null;
  /** Sum of the order parts' EFFECTIVE prices (override ?? SKU) — the estimate base. */
  partsValueCents: number;
}

/**
 * A complete buyback order ALWAYS carries its hand-entered value — a NULL
 * there is an inconsistent completion write, not a zero to display (the
 * loud-failure seam for the CHECK-less column; the reports domain shares
 * this guard). Open orders legitimately read NULL: the value is unknown
 * until the supplier pays.
 */
export function buybackOrderValueCents(order: {
  number: number;
  status: string;
  order_value_cents: number | null;
}): number | null {
  if (order.status === "complete") {
    if (order.order_value_cents === null) {
      throw new Error(
        `buyback order #${order.number} is complete but carries no order value — the completion write is inconsistent`
      );
    }
  }
  return order.order_value_cents;
}

function orderTotals(db: Database.Database, order: BuybackOrderRow): OrderTotals {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS part_count,
              COALESCE(SUM(COALESCE(p.price_cents, s.price_cents)), 0) AS parts_value_cents
         FROM buyback_order_parts bp
         JOIN serialized_parts p ON p.id = bp.part_id
         JOIN skus s ON s.id = p.sku_id
        WHERE bp.buyback_order_id = ?`
    )
    .get(order.id) as { part_count: number; parts_value_cents: number };
  return {
    partCount: row.part_count,
    orderValueCents: order.order_value_cents,
    partsValueCents: row.parts_value_cents,
  };
}

const ORDER_PARTS_SELECT = `
  SELECT bp.part_id, p.serial, p.sku_id, s.name AS sku_name,
         COALESCE(p.price_cents, s.price_cents) AS effective_price_cents,
         bp.added_at, u.email AS added_by_email
    FROM buyback_order_parts bp
    JOIN serialized_parts p ON p.id = bp.part_id
    JOIN skus s ON s.id = p.sku_id
    LEFT JOIN users u ON u.id = bp.added_by
   WHERE bp.buyback_order_id = ?
   ORDER BY bp.id
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
  };
}

function serializeOrderSummary(db: Database.Database, row: BuybackOrderRow) {
  const creator = db.prepare("SELECT email FROM users WHERE id = ?").get(row.created_by) as {
    email: string;
  };
  // A complete order always carries its hand-entered value — see
  // buybackOrderValueCents, the one guard both this summary and the reports
  // domain read through.
  const totals = orderTotals(db, {
    ...row,
    order_value_cents: buybackOrderValueCents(row),
  });
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    statusLabel: BUYBACK_STATUS_LABELS[row.status],
    createdAt: row.created_at,
    createdByEmail: creator.email,
    completedAt: row.completed_at,
    ...totals,
    // CONTEXT.md (Buyback Order): the estimated recovery of an OPEN order is
    // 10% of its parts' price sum. Display-only; the hand-entered order
    // value is the real revenue record.
    estimatedValueCents: Math.round(totals.partsValueCents * BUYBACK_ESTIMATE_RATIO),
  };
}

function serializeOrderDetail(db: Database.Database, row: BuybackOrderRow) {
  return {
    ...serializeOrderSummary(db, row),
    parts: listOrderParts(db, row.id).map(serializeOrderPart),
    events: timelineFor(db, "buyback", row.id),
  };
}

/** The open (In-Transit) order a part is attached to, if any. */
function openOrderForPart(db: Database.Database, partId: number): { id: number; number: number } | undefined {
  return db
    .prepare(
      `SELECT o.id, o.number
         FROM buyback_order_parts bp JOIN buyback_orders o ON o.id = bp.buyback_order_id
        WHERE bp.part_id = ? AND o.status = 'in_transit'`
    )
    .get(partId) as { id: number; number: number } | undefined;
}

function getPartBySerial(db: Database.Database, serial: string): { id: number; status: string } | undefined {
  return db
    .prepare("SELECT id, status FROM serialized_parts WHERE serial = ?")
    .get(serial) as { id: number; status: string } | undefined;
}

export const buybacksDomain: Domain = {
  name: "buybacks",
  register(app: Express, ctx: AppContext) {
    const api = getApiRouter(app);
    const buybackOrders = Router();

    // ---- creation (any user; required opening note) -----------------------

    buybackOrders.post("/", (req, res) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "an opening note is required");
        return;
      }
      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const create = ctx.db.transaction((): number => {
        // Sequential human numbers: #1, #2, ... — RMA-orders-style, "#N".
        const next = ctx.db
          .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM buyback_orders")
          .get() as { n: number };
        const result = ctx.db
          .prepare(
            "INSERT INTO buyback_orders (number, status, created_at, created_by, completed_at) VALUES (?, 'in_transit', ?, ?, NULL)"
          )
          .run(next.n, now, actor.id);
        const id = Number(result.lastInsertRowid);
        recordEvent(ctx.db, ctx.clock, {
          entityType: "buyback",
          entityId: id,
          actorId: actor.id,
          action: "buyback.created",
          payload: { number: next.n },
        });
        // The required opening note is the timeline's first note.added event.
        recordEvent(ctx.db, ctx.clock, {
          entityType: "buyback",
          entityId: id,
          actorId: actor.id,
          action: "note.added",
          payload: { text: parsed.data.note },
        });
        return id;
      });
      const id = create();
      res.status(201).json(serializeOrderDetail(ctx.db, getOrderRow(ctx.db, id) as BuybackOrderRow));
    });

    buybackOrders.get("/", (_req, res) => {
      const rows = ctx.db
        .prepare(
          "SELECT id, number, status, created_at, created_by, completed_at, order_value_cents FROM buyback_orders ORDER BY number DESC"
        )
        .all() as BuybackOrderRow[];
      res.json(rows.map((row) => serializeOrderSummary(ctx.db, row)));
    });

    buybackOrders.get("/:id", (req, res) => {
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid buyback order id");
        return;
      }
      const row = getOrderRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no buyback order with that id" });
        return;
      }
      res.json(serializeOrderDetail(ctx.db, row));
    });

    // ---- notes (immutable, user-stamped, merged into the timeline) -------

    registerNotesRoute(buybackOrders, ctx, {
      entityType: "buyback",
      notFoundMessage: "no buyback order with that id",
      invalidIdMessage: "invalid buyback order id",
      exists: (db, id) => getOrderRow(db, id) !== undefined,
    });

    buybackOrders.get("/:id/timeline", (req, res) => {
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid buyback order id");
        return;
      }
      const row = getOrderRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no buyback order with that id" });
        return;
      }
      res.json(timelineFor(ctx.db, "buyback", id));
      // One immutable timeline: there are no note/event edit or delete
      // endpoints anywhere in this domain, on purpose.
    });

    // ---- scan-to-add (the scanner types a serial; no note needed) --------

    buybackOrders.post("/:id/parts", (req, res) => {
      const parsed = scanSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a serial is required");
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid buyback order id");
        return;
      }
      const order = getOrderRow(ctx.db, id);
      if (!order) {
        res.status(404).json({ error: "no buyback order with that id" });
        return;
      }
      if (order.status === "complete") {
        res.status(409).json({
          error: `buyback order #${order.number} is complete — its parts are settled and can no longer be added`,
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
              ? `${serial} is already on this buyback order (#${order.number})`
              : `${serial} is already on buyback order #${attached.number} — a part can be on only one open buyback order`,
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
      if (part.status !== "buyback") {
        res.status(409).json({
          error: `${serial} is ${partStatusLabel(part.status)} — only Buyback-status parts can be added to a buyback order`,
        });
        return;
      }
      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const add = ctx.db.transaction((): void => {
        ctx.db
          .prepare(
            "INSERT INTO buyback_order_parts (buyback_order_id, part_id, added_at, added_by) VALUES (?, ?, ?, ?)"
          )
          .run(order.id, part.id, now, actor.id);
        // Ticket 29: the scan itself moves the part Buyback → In-Transit
        // through the guarded transition, so inventory reads "gone with the
        // shipment" at a glance; both timelines record the attachment.
        const moved = changePartStatus(ctx.db, ctx.clock, actor, {
          partId: part.id,
          to: "in_transit",
          note: `Scanned onto buyback order #${order.number}`,
          via: "order_scan",
          expectedFrom: "buyback",
          payload: { buybackOrderId: order.id, buybackNumber: order.number },
        });
        if (!moved.ok) {
          throw new Error(`buyback scan could not move part ${serial} to In-Transit: ${moved.message}`);
        }
        recordEvent(ctx.db, ctx.clock, {
          entityType: "buyback",
          entityId: order.id,
          actorId: actor.id,
          action: "buyback.part_added",
          payload: { serial },
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "part",
          entityId: part.id,
          actorId: actor.id,
          action: "part.added_to_buyback",
          payload: { buybackOrderId: order.id, buybackNumber: order.number },
        });
      });
      add();
      res.status(201).json(serializeOrderDetail(ctx.db, getOrderRow(ctx.db, order.id) as BuybackOrderRow));
    });

    // ---- Complete (any user; required note; ONE hand-entered order value) --

    buybackOrders.post("/:id/complete", (req, res) => {
      const parsed = completeSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a completion note and the order's value are required");
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid buyback order id");
        return;
      }
      const order = getOrderRow(ctx.db, id);
      if (!order) {
        res.status(404).json({ error: "no buyback order with that id" });
        return;
      }
      if (order.status === "complete") {
        res.status(409).json({ error: `buyback order #${order.number} is already complete` });
        return;
      }

      const orderParts = listOrderParts(ctx.db, order.id);
      if (orderParts.length === 0) {
        badRequest(res, "a buyback order with no parts can't be completed — scan parts onto it first");
        return;
      }

      // Money at the edge: the whole shipment settles for one hand-entered
      // amount — the lump sum the supplier paid. A settlement never guesses,
      // so the value is required even when it is 0.
      const orderValueCents = parsePriceToCents(parsed.data.orderValue);
      if (orderValueCents === null) {
        badRequest(res, PRICE_MESSAGE);
        return;
      }

      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const complete = ctx.db.transaction((): void => {
        for (const orderPart of orderParts) {
          // Every part becomes Unavailable — through the part-status module,
          // guarded on the In-Transit status the scan gave the part while its
          // order is in transit (ticket 29). There is no per-part settlement:
          // the attachment row is the part's whole story on the order.
          const settled = changePartStatus(ctx.db, ctx.clock, actor, {
            partId: orderPart.part_id,
            to: "unavailable",
            note: parsed.data.note,
            via: "buyback_complete",
            expectedFrom: "in_transit",
            payload: {
              buybackOrderId: order.id,
              buybackNumber: order.number,
            },
          });
          if (!settled.ok) {
            throw new Error(
              `buyback completion could not settle part ${orderPart.serial}: ${settled.message}`
            );
          }
        }
        // The order's timeline: the value, then the completion note, then the
        // transition itself.
        recordEvent(ctx.db, ctx.clock, {
          entityType: "buyback",
          entityId: order.id,
          actorId: actor.id,
          action: "buyback.settled",
          payload: { orderValueCents },
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "buyback",
          entityId: order.id,
          actorId: actor.id,
          action: "note.added",
          payload: { text: parsed.data.note },
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "buyback",
          entityId: order.id,
          actorId: actor.id,
          action: "buyback.status_changed",
          payload: { from: "in_transit", to: "complete" },
        });
        ctx.db
          .prepare(
            "UPDATE buyback_orders SET status = 'complete', completed_at = ?, order_value_cents = ? WHERE id = ?"
          )
          .run(now, orderValueCents, order.id);
      });
      complete();
      res.json(serializeOrderDetail(ctx.db, getOrderRow(ctx.db, order.id) as BuybackOrderRow));
    });

    api.use("/buyback-orders", buybackOrders);

    // ---- the Buyback pool ---------------------------------------------------
    //
    // Ticket 29: the pool is unscanned Buyback parts PLUS the parts already
    // In-Transit on an open buyback order (they show with their order link).
    api.get("/buyback-parts", (_req, res) => {
      const rows = ctx.db
        .prepare(
          `SELECT p.id, p.serial, p.sku_id, s.name AS sku_name,
                  o.id AS buyback_order_id, o.number AS buyback_number
             FROM serialized_parts p
             JOIN skus s ON s.id = p.sku_id
             LEFT JOIN buyback_orders o
                   ON o.status = 'in_transit'
                   AND EXISTS (SELECT 1 FROM buyback_order_parts bp
                                WHERE bp.buyback_order_id = o.id AND bp.part_id = p.id)
            WHERE p.status = 'buyback'
               OR (p.status = 'in_transit' AND o.id IS NOT NULL)
            ORDER BY p.id`
        )
        .all() as Array<{
        id: number;
        serial: string;
        sku_id: number;
        sku_name: string;
        buyback_order_id: number | null;
        buyback_number: number | null;
      }>;
      res.json(
        rows.map((row) => ({
          id: row.id,
          serial: row.serial,
          skuId: row.sku_id,
          skuName: row.sku_name,
          buybackOrderId: row.buyback_order_id,
          buybackNumber: row.buyback_number,
        })),
      );
    });

    // ---- the pool override (ticket 27) ------------------------------------
    //
    // Move a pooled part out BEFORE it is scanned onto an order: the supplier
    // program will not take it, or it turned out to be worth keeping. Through
    // the part-status module (via part_endpoint), whose guards apply — note
    // required, no Reserved part, and a part on an in-transit buyback order
    // is already committed to its shipment and refuses here too.
    api.post("/buyback-parts/:id/override", (req, res) => {
      const parsed = overrideSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(
          res,
          "a destination (available, rma, damaged_by_tech, or unavailable) and a note are required — a part never leaves the pool silently"
        );
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid part id");
        return;
      }
      const part = ctx.db
        .prepare("SELECT id, serial, status FROM serialized_parts WHERE id = ?")
        .get(id) as { id: number; serial: string; status: string } | undefined;
      if (!part) {
        res.status(404).json({ error: `no serialized part with id ${id}` });
        return;
      }
      if (part.status !== "buyback") {
        res.status(409).json({
          error: `${part.serial} is ${partStatusLabel(part.status)} — only Buyback-status parts are in the pool`,
        });
        return;
      }
      const result = changePartStatus(ctx.db, ctx.clock, req.currentUser!, {
        partId: part.id,
        to: parsed.data.destination,
        note: parsed.data.note,
        via: "part_endpoint",
      });
      if (!result.ok) {
        res.status(result.http).json({ error: result.message });
        return;
      }
      res.json({ ok: true, serial: part.serial, status: parsed.data.destination });
    });
  },
};
