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
import { formatCents } from "../parts/prices.js";

/**
 * The returns domain (ticket 29): shipments of **Available** parts back to
 * a vendor that earn money without waiting for anyone — a **Return Order**
 * books each part's price as revenue when the order completes, unlike an
 * RMA order (credit entered by hand when the vendor accepts) or a buyback
 * order (one order value entered by hand when the supplier pays).
 *
 * The structure mirrors the RMA domain: created with a required opening
 * note, In-Transit from creation (no approval gate); scanning (typing) a
 * serial attaches an Available part and moves it to the shared
 * **In-Transit** part status (ticket 29). On Complete — any user, required
 * note — every part becomes **Unavailable**, and the order line snapshots
 * the part's EFFECTIVE price (Part Price override ?? SKU price, ticket 23):
 * the revenue record the returns-revenue report (ticket 12's seam) reads.
 * The snapshot at completion is deliberate — money the shop books is money
 * the shipment actually carried, and a later reprice cannot rewrite it.
 *
 * No per-part dispositions: a Return Order's whole point is that the value
 * needs no manual entry. There is no second door — the bare part endpoint
 * refuses to touch a part attached to an open order (parts/status.ts).
 *
 * While the order is open, its Revenue column shows the current effective-
 * price sum (100% — the estimate IS the commitment).
 *
 * Money is integer cents in storage, dollars only at the edges.
 */

type ReturnOrderStatus = "in_transit" | "complete";

const RETURN_STATUS_LABELS: Record<ReturnOrderStatus, string> = {
  in_transit: "In-Transit",
  complete: "Complete",
};

const createSchema = z.object({ note: z.string().trim().min(1) });

const scanSchema = z.object({ serial: z.string().trim().min(1) });

const completeSchema = z.object({ note: z.string().trim().min(1) });

interface ReturnOrderRow {
  id: number;
  number: number;
  status: ReturnOrderStatus;
  created_at: string;
  created_by: number;
  completed_at: string | null;
}

interface OrderPartView {
  id: number;
  part_id: number;
  serial: string;
  sku_id: number;
  sku_name: string;
  effective_price_cents: number;
  price_cents: number | null;
  added_at: string;
  added_by_email: string;
  settled_at: string | null;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function parseId(raw: string): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function getOrderRow(db: Database.Database, id: number): ReturnOrderRow | undefined {
  return db
    .prepare(
      "SELECT id, number, status, created_at, created_by, completed_at FROM return_orders WHERE id = ?"
    )
    .get(id) as ReturnOrderRow | undefined;
}

interface OrderTotals {
  partCount: number;
  /** Completed: the snapshotted revenue sum. Open: the same SUM reads 0. */
  revenueCents: number;
  /** Sum of the order parts' EFFECTIVE prices (override ?? SKU). */
  partsValueCents: number;
}

function orderTotals(db: Database.Database, orderId: number): OrderTotals {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS part_count,
              COALESCE(SUM(tp.price_cents), 0) AS revenue_cents,
              COALESCE(SUM(COALESCE(p.price_cents, s.price_cents)), 0) AS parts_value_cents
         FROM return_order_parts tp
         JOIN serialized_parts p ON p.id = tp.part_id
         JOIN skus s ON s.id = p.sku_id
        WHERE tp.return_order_id = ?`
    )
    .get(orderId) as { part_count: number; revenue_cents: number; parts_value_cents: number };
  return {
    partCount: row.part_count,
    revenueCents: row.revenue_cents,
    partsValueCents: row.parts_value_cents,
  };
}

const ORDER_PARTS_SELECT = `
  SELECT tp.id, tp.part_id, p.serial, p.sku_id, s.name AS sku_name,
         COALESCE(p.price_cents, s.price_cents) AS effective_price_cents,
         tp.price_cents, tp.added_at, u.email AS added_by_email, tp.settled_at
    FROM return_order_parts tp
    JOIN serialized_parts p ON p.id = tp.part_id
    JOIN skus s ON s.id = p.sku_id
    LEFT JOIN users u ON u.id = tp.added_by
   WHERE tp.return_order_id = ?
   ORDER BY tp.id
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
    // While open: what completion would book. After: the booked price.
    priceCents: row.price_cents ?? row.effective_price_cents,
    price: formatCents(row.price_cents ?? row.effective_price_cents),
    booked: row.price_cents !== null,
    addedAt: row.added_at,
    addedByEmail: row.added_by_email,
    settledAt: row.settled_at,
  };
}

function serializeOrderSummary(db: Database.Database, row: ReturnOrderRow) {
  const creator = db.prepare("SELECT email FROM users WHERE id = ?").get(row.created_by) as {
    email: string;
  };
  const totals = orderTotals(db, row.id);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    statusLabel: RETURN_STATUS_LABELS[row.status],
    createdAt: row.created_at,
    createdByEmail: creator.email,
    completedAt: row.completed_at,
    partCount: totals.partCount,
    revenueCents: totals.revenueCents,
    // CONTEXT.md (Return Order): the parts' price sum IS the revenue —
    // booked at completion, shown at 100% while open.
    estimatedValueCents: totals.partsValueCents,
  };
}

function serializeOrderDetail(db: Database.Database, row: ReturnOrderRow) {
  return {
    ...serializeOrderSummary(db, row),
    parts: listOrderParts(db, row.id).map(serializeOrderPart),
    events: timelineFor(db, "return", row.id),
  };
}

/** The open (In-Transit) return order a part is attached to, if any. */
function openOrderForPart(db: Database.Database, partId: number): { id: number; number: number } | undefined {
  return db
    .prepare(
      `SELECT o.id, o.number
         FROM return_order_parts tp JOIN return_orders o ON o.id = tp.return_order_id
        WHERE tp.part_id = ? AND o.status = 'in_transit'`
    )
    .get(partId) as { id: number; number: number } | undefined;
}

function getPartBySerial(db: Database.Database, serial: string): { id: number; status: string } | undefined {
  return db
    .prepare("SELECT id, status FROM serialized_parts WHERE serial = ?")
    .get(serial) as { id: number; status: string } | undefined;
}

export const returnsDomain: Domain = {
  name: "returns",
  register(app: Express, ctx: AppContext) {
    const api = getApiRouter(app);
    const returnOrders = Router();

    // ---- creation (any user; required opening note) -----------------------

    returnOrders.post("/", (req, res) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "an opening note is required");
        return;
      }
      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const create = ctx.db.transaction((): number => {
        // Sequential human numbers: #1, #2, ... — RMA-orders-style, "#N".
        // Its own number space: a return order #4 is not RMA order #4.
        const next = ctx.db
          .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM return_orders")
          .get() as { n: number };
        const result = ctx.db
          .prepare(
            "INSERT INTO return_orders (number, status, created_at, created_by, completed_at) VALUES (?, 'in_transit', ?, ?, NULL)"
          )
          .run(next.n, now, actor.id);
        const id = Number(result.lastInsertRowid);
        recordEvent(ctx.db, ctx.clock, {
          entityType: "return",
          entityId: id,
          actorId: actor.id,
          action: "return.created",
          payload: { number: next.n },
        });
        // The required opening note is the timeline's first note.added event.
        recordEvent(ctx.db, ctx.clock, {
          entityType: "return",
          entityId: id,
          actorId: actor.id,
          action: "note.added",
          payload: { text: parsed.data.note },
        });
        return id;
      });
      const id = create();
      res.status(201).json(serializeOrderDetail(ctx.db, getOrderRow(ctx.db, id) as ReturnOrderRow));
    });

    returnOrders.get("/", (_req, res) => {
      const rows = ctx.db
        .prepare(
          "SELECT id, number, status, created_at, created_by, completed_at FROM return_orders ORDER BY number DESC"
        )
        .all() as ReturnOrderRow[];
      res.json(rows.map((row) => serializeOrderSummary(ctx.db, row)));
    });

    returnOrders.get("/:id", (req, res) => {
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid return order id");
        return;
      }
      const row = getOrderRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no return order with that id" });
        return;
      }
      res.json(serializeOrderDetail(ctx.db, row));
    });

    // ---- notes (immutable, user-stamped, merged into the timeline) -------

    registerNotesRoute(returnOrders, ctx, {
      entityType: "return",
      notFoundMessage: "no return order with that id",
      invalidIdMessage: "invalid return order id",
      exists: (db, id) => getOrderRow(db, id) !== undefined,
    });

    returnOrders.get("/:id/timeline", (req, res) => {
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid return order id");
        return;
      }
      const row = getOrderRow(ctx.db, id);
      if (!row) {
        res.status(404).json({ error: "no return order with that id" });
        return;
      }
      res.json(timelineFor(ctx.db, "return", id));
      // One immutable timeline: there are no note/event edit or delete
      // endpoints anywhere in this domain, on purpose.
    });

    // ---- scan-to-add (the scanner types a serial; no note needed) --------

    returnOrders.post("/:id/parts", (req, res) => {
      const parsed = scanSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a serial is required");
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid return order id");
        return;
      }
      const order = getOrderRow(ctx.db, id);
      if (!order) {
        res.status(404).json({ error: "no return order with that id" });
        return;
      }
      if (order.status === "complete") {
        res.status(409).json({
          error: `return order #${order.number} is complete — its parts are settled and can no longer be added`,
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
              ? `${serial} is already on this return order (#${order.number})`
              : `${serial} is already on return order #${attached.number} — a part can be on only one open return order`,
        });
        return;
      }
      // An In-Transit part is physically gone with another shipment (ticket
      // 29) — name the order that owns it.
      const inTransitOn = openInTransitOrder(ctx.db, part.id);
      if (inTransitOn) {
        res.status(409).json({
          error: `${serial} is in transit on ${outboundOrderLabel(inTransitOn.kind)} #${inTransitOn.number} — a part can be on only one open order`,
        });
        return;
      }
      // The difference from RMA/buyback: a Return Order takes AVAILABLE
      // parts — the stock leaves circulation directly.
      if (part.status !== "available") {
        res.status(409).json({
          error: `${serial} is ${partStatusLabel(part.status)} — only Available parts can be added to a return order`,
        });
        return;
      }
      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const add = ctx.db.transaction((): void => {
        ctx.db
          .prepare(
            "INSERT INTO return_order_parts (return_order_id, part_id, added_at, added_by) VALUES (?, ?, ?, ?)"
          )
          .run(order.id, part.id, now, actor.id);
        // The scan moves the part Available → In-Transit through the guarded
        // transition, so the unit leaves the reservable pool the moment it
        // joins the shipment.
        const moved = changePartStatus(ctx.db, ctx.clock, actor, {
          partId: part.id,
          to: "in_transit",
          note: `Scanned onto return order #${order.number}`,
          via: "order_scan",
          expectedFrom: "available",
          payload: { returnOrderId: order.id, returnNumber: order.number },
        });
        if (!moved.ok) {
          throw new Error(`return scan could not move part ${serial} to In-Transit: ${moved.message}`);
        }
        recordEvent(ctx.db, ctx.clock, {
          entityType: "return",
          entityId: order.id,
          actorId: actor.id,
          action: "return.part_added",
          payload: { serial },
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "part",
          entityId: part.id,
          actorId: actor.id,
          action: "part.added_to_return",
          payload: { returnOrderId: order.id, returnNumber: order.number },
        });
      });
      add();
      res.status(201).json(serializeOrderDetail(ctx.db, getOrderRow(ctx.db, order.id) as ReturnOrderRow));
    });

    // ---- Complete (any user; required note; the revenue booking) ---------

    returnOrders.post("/:id/complete", (req, res) => {
      const parsed = completeSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a completion note is required");
        return;
      }
      const id = parseId(req.params.id);
      if (id === undefined) {
        badRequest(res, "invalid return order id");
        return;
      }
      const order = getOrderRow(ctx.db, id);
      if (!order) {
        res.status(404).json({ error: "no return order with that id" });
        return;
      }
      if (order.status === "complete") {
        res.status(409).json({ error: `return order #${order.number} is already complete` });
        return;
      }
      const orderParts = listOrderParts(ctx.db, order.id);
      if (orderParts.length === 0) {
        badRequest(res, "a return order with no parts can't be completed — scan parts onto it first");
        return;
      }

      const actor = req.currentUser!;
      const now = ctx.clock.now().toISOString();
      const complete = ctx.db.transaction((): void => {
        for (const orderPart of orderParts) {
          // The revenue booking: the part's EFFECTIVE price snapshotted onto
          // the order line — the return record reports read forever.
          const bookedCents = orderPart.effective_price_cents;
          recordEvent(ctx.db, ctx.clock, {
            entityType: "return",
            entityId: order.id,
            actorId: actor.id,
            action: "return.part_settled",
            payload: { serial: orderPart.serial, priceCents: bookedCents },
          });
          // Every part becomes Unavailable — through the part-status module,
          // guarded on the In-Transit status the scan gave it (ticket 29).
          const settled = changePartStatus(ctx.db, ctx.clock, actor, {
            partId: orderPart.part_id,
            to: "unavailable",
            note: parsed.data.note,
            via: "return_complete",
            expectedFrom: "in_transit",
            payload: {
              returnOrderId: order.id,
              returnNumber: order.number,
              priceCents: bookedCents,
            },
          });
          if (!settled.ok) {
            throw new Error(
              `return completion could not settle part ${orderPart.serial}: ${settled.message}`
            );
          }
          ctx.db
            .prepare("UPDATE return_order_parts SET price_cents = ?, settled_at = ? WHERE id = ?")
            .run(bookedCents, now, orderPart.id);
        }
        // The completion note, then the transition itself.
        recordEvent(ctx.db, ctx.clock, {
          entityType: "return",
          entityId: order.id,
          actorId: actor.id,
          action: "note.added",
          payload: { text: parsed.data.note },
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "return",
          entityId: order.id,
          actorId: actor.id,
          action: "return.status_changed",
          payload: { from: "in_transit", to: "complete" },
        });
        ctx.db
          .prepare("UPDATE return_orders SET status = 'complete', completed_at = ? WHERE id = ?")
          .run(now, order.id);
      });
      complete();
      res.json(serializeOrderDetail(ctx.db, getOrderRow(ctx.db, order.id) as ReturnOrderRow));
    });

    api.use("/return-orders", returnOrders);
  },
};
