import type Database from "better-sqlite3";
import { buybackOrderValueCents } from "../buybacks/index.js";
import { timelineEvents } from "../auth/timeline.js";
import { BATCH_CLOSE_REASONS } from "../batchparts/queries.js";

/**
 * The reports queries (ticket 12): every report reads the seams as they
 * landed — the one timeline (auth/timeline.ts `timelineEvents`) for status
 * events, and each domain's own tables for its recorded facts:
 *
 * - Total expenses: the money the shop actually spent, counted at RECEIPT.
 *   Every purchase-order receipt in the interval is an expense line — a
 *   serialized unit at its line's unit cost (purchase_order_expected_serials,
 *   the physical received record; the same cost is stamped onto the part,
 *   ticket 23), a consumable receipt at quantity × line unit cost (the
 *   `po.consumable_received` events — the line's received_quantity is a
 *   running total with no per-receipt rows, so the event IS the dated
 *   receipt). Consumption is deliberately NOT the basis: a received part is
 *   spent money whether or not a repair ever consumes it, and the ordered
 *   lines total would overstate spend because a shortfall close usually
 *   means the vendor failed to ship (or the line was a mistake), not that
 *   the shop never owed for what did arrive. Consumable usage is not an
 *   expense either — it would double-count the receipts (device_consumables
 *   remains the Parts Cost record). PO shipping is `purchase_orders` at
 *   creation — the ordering decision is when the freight is incurred.
 *   Intake source still matters for one listing (CONTEXT.md: Intake
 *   Source): consumed migration/salvage parts never had a purchase cost, so
 *   the close-settlement events (BATCH_CLOSE_REASONS — the ticket-03
 *   status-aware settlement's write shape, batchparts/queries.ts) feed the
 *   separate non-purchased consumption section, excluded from the total.
 * - RMA recovery: `rma_order_parts` dispositions, interval on the order's
 *   `completed_at` — credits are entered BY HAND at completion when the
 *   vendor accepts (spec story 56); the open-order estimate (50%) never
 *   enters a report.
 * - Buyback recovery: the hand-entered order value on complete buyback
 *   orders (one value per shipment — no per-part dispositions), interval on
 *   the order's `completed_at`.
 * - Returns revenue (ticket 29): `return_order_parts` price snapshots,
 *   interval on the order's `completed_at` — return revenue is BOOKED, not
 *   entered (CONTEXT.md: Return Order).
 * - Batches completed: `batches.closed_at` with device counts grouped by
 *   final Repair Status.
 * - Shrink: Damaged by Tech events (`part.removed` from a batch removal or
 *   `part.status_changed` from the bare endpoint — both carry
 *   `to: "damaged_by_tech"` and an acting tech) and audit failures
 *   (`audit_parts.outcome = 'failed'`), each priced at the SKU price.
 * - Per-tech stats: `device.status_changed` events with
 *   `to: "Repaired"` (the acting tech completed the repair) and the same
 *   Damaged by Tech events, grouped by actor.
 *
 * All intervals are inclusive `[from, to]` over the stored ISO timestamps.
 *
 * Inconsistencies fail loudly (AGENTS.md review standard): a settlement
 * event without its batch/device reference, a consumed part without a
 * device_parts row, a consumable receipt whose line no longer exists, a
 * part without an intake source, a damaged event
 * without an actor — each throws rather than being guessed around.
 */

export interface Interval {
  /** Inclusive lower date, YYYY-MM-DD. */
  from: string;
  /** Inclusive upper date, YYYY-MM-DD. */
  to: string;
  /** ISO lower bound: `from` at 00:00:00.000Z. */
  fromBound: string;
  /** Exclusive ISO upper bound: the day after `to` at 00:00:00.000Z. */
  toBound: string;
}

// ---- total expenses ---------------------------------------------------------

export interface ExpenseLine {
  at: string;
  category: "Received part" | "Received consumable" | "PO shipping";
  reference: string;
  detail: string;
  amountCents: number;
}

export interface NonPurchasedConsumption {
  at: string;
  reference: string;
  serial: string;
  sku: string;
  intakeSource: string;
  priceCents: number;
}

/**
 * The expense report: receipt-based spend. Interval on the RECEIPT moment —
 * received_at for serialized units, the receipt event's timestamp for
 * consumables — plus shipping at creation. The non-purchased section stays
 * consumption-based (its subject is parts that were never bought).
 */
export interface ExpenseReport {
  lines: ExpenseLine[];
  nonPurchased: NonPurchasedConsumption[];
  totalCents: number;
  nonPurchasedTotalCents: number;
}

interface ConsumedPartRow {
  serial: string;
  skuName: string;
  intakeSource: string;
  priceCents: number;
}

function consumedPartCost(
  db: Database.Database,
  partId: number,
  deviceId: number
): ConsumedPartRow {
  // Used ONLY by the non-purchased consumption listing: the expense total
  // counts receipts, so a consumed part's snapshotted attachment price
  // matters exactly when the part was never bought (migration/salvage).
  const row = db
    .prepare(
      `SELECT p.serial, s.name AS sku_name, p.intake_source, dp.price_cents
         FROM device_parts dp
         JOIN serialized_parts p ON p.id = dp.part_id
         JOIN skus s ON s.id = p.sku_id
        WHERE dp.part_id = ? AND dp.device_id = ?
        ORDER BY dp.id DESC LIMIT 1`
    )
    .get(partId, deviceId) as
    | { serial: string; sku_name: string; intake_source: string | null; price_cents: number }
    | undefined;
  if (!row) {
    throw new Error(
      `part ${partId} was settled by a batch close but has no device_parts attachment on device ${deviceId} — the settlement records disagree`
    );
  }
  if (row.intake_source === null) {
    throw new Error(
      `part ${row.serial} has no intake source — intake seams must always set one (migration 0013)`
    );
  }
  return {
    serial: row.serial,
    skuName: row.sku_name,
    intakeSource: row.intake_source,
    priceCents: row.price_cents,
  };
}

export function expenseReport(db: Database.Database, interval: Interval): ExpenseReport {
  const lines: ExpenseLine[] = [];
  const nonPurchased: NonPurchasedConsumption[] = [];

  // Received serialized parts: the physical receipt record. A unit counts
  // the moment it ARRIVES, at ITS line's unit cost — the amount actually
  // paid for that unit (stamped onto the part at receipt, ticket 23).
  // Whether a repair later consumes the unit is irrelevant to the spend:
  // the money left when the goods did.
  const receivedParts = db
    .prepare(
      `SELECT e.received_at AS at, e.serial, l.unit_price_cents, s.name AS sku_name,
              po.number AS po_number
         FROM purchase_order_expected_serials e
         JOIN purchase_order_lines l ON l.id = e.line_id
         JOIN purchase_orders po ON po.id = l.po_id
         JOIN skus s ON s.id = l.sku_id
        WHERE e.part_id IS NOT NULL AND e.received_at >= ? AND e.received_at < ?
        ORDER BY e.id`
    )
    .all(interval.fromBound, interval.toBound) as Array<{
    at: string;
    serial: string;
    unit_price_cents: number;
    sku_name: string;
    po_number: number;
  }>;
  for (const row of receivedParts) {
    lines.push({
      at: row.at,
      category: "Received part",
      reference: `PO #${row.po_number}`,
      detail: `${row.serial} — ${row.sku_name}`,
      amountCents: row.unit_price_cents,
    });
  }

  // Received consumables: the receipt events. Lines are frozen after
  // approval, so the unit cost a receipt landed under IS the paid price.
  const consumableReceipts = timelineEvents(
    db,
    "e.action = 'po.consumable_received' AND e.at >= ? AND e.at < ?",
    [interval.fromBound, interval.toBound]
  );
  for (const event of consumableReceipts) {
    const payload = event.payload as
      | { lineId?: unknown; sku?: unknown; quantity?: unknown }
      | null;
    if (
      typeof payload?.lineId !== "number" ||
      typeof payload?.sku !== "string" ||
      typeof payload?.quantity !== "number"
    ) {
      throw new Error(
        `po.consumable_received event ${event.id} is missing its line/sku/quantity reference — the receipt event shape changed`
      );
    }
    const line = db
      .prepare(
        `SELECT l.unit_price_cents, po.number AS po_number
           FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.po_id
          WHERE l.id = ?`
      )
      .get(payload.lineId) as { unit_price_cents: number; po_number: number } | undefined;
    if (!line) {
      throw new Error(
        `po.consumable_received event ${event.id} names line ${payload.lineId}, which no longer exists — the receipt record is inconsistent`
      );
    }
    lines.push({
      at: event.at,
      category: "Received consumable",
      reference: `PO #${line.po_number}`,
      detail: `${payload.sku} x ${payload.quantity}`,
      amountCents: payload.quantity * line.unit_price_cents,
    });
  }

  // Non-purchased consumption (excluded from the total): the close
  // settlement's per-part events. A close settlement consumes a part
  // exactly when it ends it UNAVAILABLE: the leftover path (Additional
  // issues / Denied Repair) and the Repaired-non-buybackable path. The
  // Buyback and Available destinations are recovery, not consumption —
  // BATCH_CLOSE_REASONS is the vocabulary's single source
  // (batchparts/queries.ts).
  const events = timelineEvents(
    db,
    "e.action = 'part.status_changed' AND e.at >= ? AND e.at < ?",
    [interval.fromBound, interval.toBound]
  );
  for (const event of events) {
    const payload = event.payload as
      | { to?: unknown; reason?: unknown; batchNumber?: unknown; deviceId?: unknown }
      | null;
    if (
      payload?.to !== "unavailable" ||
      (payload.reason !== BATCH_CLOSE_REASONS.leftoverUnavailable &&
        payload.reason !== BATCH_CLOSE_REASONS.repairedUnavailable)
    ) {
      continue;
    }
    if (typeof payload.batchNumber !== "number" || typeof payload.deviceId !== "number") {
      throw new Error(
        `batch-settlement event ${event.id} is missing its batch/device reference — the settlement event shape changed`
      );
    }
    const consumed = consumedPartCost(db, event.entityId, payload.deviceId);
    // Migration/salvage parts have no purchase cost (CONTEXT.md: Intake
    // Source) — listed for transparency, excluded from the expense total.
    // A consumed PURCHASED part is not listed at all: its cost was already
    // counted as an expense when the PO delivered it.
    if (consumed.intakeSource !== "purchase-order") {
      nonPurchased.push({
        at: event.at,
        reference: `Batch #${payload.batchNumber}`,
        serial: consumed.serial,
        sku: consumed.skuName,
        intakeSource: consumed.intakeSource,
        priceCents: consumed.priceCents,
      });
    }
  }

  // PO shipping: counted when the order is placed.
  const shipping = db
    .prepare(
      `SELECT number, purpose, shipping_cost_cents, created_at AS at
         FROM purchase_orders
        WHERE created_at >= ? AND created_at < ?
        ORDER BY id`
    )
    .all(interval.fromBound, interval.toBound) as Array<{
    number: number;
    purpose: string;
    shipping_cost_cents: number;
    at: string;
  }>;
  for (const row of shipping) {
    lines.push({
      at: row.at,
      category: "PO shipping",
      reference: `PO #${row.number}`,
      detail: row.purpose,
      amountCents: row.shipping_cost_cents,
    });
  }

  lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  nonPurchased.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    lines,
    nonPurchased,
    totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    nonPurchasedTotalCents: nonPurchased.reduce((sum, row) => sum + row.priceCents, 0),
  };
}

// ---- RMA recovery -----------------------------------------------------------

export interface RmaPartRow {
  number: number;
  completedAt: string;
  serial: string;
  sku: string;
  creditCents: number;
  note: string;
}

export interface RmaRecoveryReport {
  credited: RmaPartRow[];
  rejected: RmaPartRow[];
  totalCreditCents: number;
}

export function rmaRecoveryReport(db: Database.Database, interval: Interval): RmaRecoveryReport {
  const rows = db
    .prepare(
      `SELECT o.number, o.completed_at, p.serial, s.name AS sku_name,
              rp.disposition, rp.credit_cents, rp.disposition_note
         FROM rma_order_parts rp
         JOIN rma_orders o ON o.id = rp.rma_order_id
         JOIN serialized_parts p ON p.id = rp.part_id
         JOIN skus s ON s.id = p.sku_id
        WHERE o.status = 'complete' AND o.completed_at >= ? AND o.completed_at < ?
        ORDER BY o.id, rp.id`
    )
    .all(interval.fromBound, interval.toBound) as Array<{
    number: number;
    completed_at: string | null;
    serial: string;
    sku_name: string;
    disposition: string;
    credit_cents: number | null;
    disposition_note: string | null;
  }>;
  const credited: RmaPartRow[] = [];
  const rejected: RmaPartRow[] = [];
  for (const row of rows) {
    if (row.completed_at === null) {
      throw new Error(
        `RMA order #${row.number} is complete but has no completed_at — the completion write is inconsistent`
      );
    }
    const base = {
      number: row.number,
      completedAt: row.completed_at,
      serial: row.serial,
      sku: row.sku_name,
      note: row.disposition_note ?? "",
    };
    if (row.disposition === "credited") {
      if (row.credit_cents === null) {
        throw new Error(
          `RMA order #${row.number}: part ${row.serial} is credited but carries no credit value`
        );
      }
      credited.push({ ...base, creditCents: row.credit_cents });
    } else if (row.disposition === "rejected") {
      // Rejected carries no value (CONTEXT.md: RMA Complete settles credited
      // or rejected alike) — listed at zero credit, excluded from the total.
      rejected.push({ ...base, creditCents: 0 });
    } else {
      throw new Error(`unknown RMA disposition: ${row.disposition}`);
    }
  }
  return {
    credited,
    rejected,
    totalCreditCents: credited.reduce((sum, row) => sum + row.creditCents, 0),
  };
}

// ---- buyback recovery (ticket 27; order-level value since 0027) -------------

export interface BuybackRecoveryRow {
  number: number;
  completedAt: string;
  orderValueCents: number;
}

export interface BuybackRecoveryReport {
  orders: BuybackRecoveryRow[];
  totalValueCents: number;
}

/**
 * The revenue mirror of `rmaRecoveryReport`, at ORDER granularity: a buyback
 * order settles for ONE hand-entered value — the lump sum the supplier paid;
 * individual parts carry no disposition or price. Interval on the order's
 * `completed_at`, like every report.
 */
export function buybackRecoveryReport(db: Database.Database, interval: Interval): BuybackRecoveryReport {
  const rows = db
    .prepare(
      `SELECT number, status, completed_at, order_value_cents
          FROM buyback_orders
         WHERE status = 'complete' AND completed_at >= ? AND completed_at < ?
         ORDER BY id`
    )
    .all(interval.fromBound, interval.toBound) as Array<{
    number: number;
    status: string;
    completed_at: string | null;
    order_value_cents: number | null;
  }>;
  const orders = rows.map((row) => {
    if (row.completed_at === null) {
      throw new Error(
        `buyback order #${row.number} is complete but has no completed_at — the completion write is inconsistent`
      );
    }
    // The one guard for "a complete buyback order always carries its value"
    // lives in the buybacks domain — shared with the order summary.
    const orderValueCents = buybackOrderValueCents(row);
    if (orderValueCents === null) {
      throw new Error(
        `buyback order #${row.number} is complete but carries no order value — the completion write is inconsistent`
      );
    }
    return { number: row.number, completedAt: row.completed_at, orderValueCents };
  });
  return {
    orders,
    totalValueCents: orders.reduce((sum, row) => sum + row.orderValueCents, 0),
  };
}

// ---- returns revenue (ticket 29) --------------------------------------------

export interface ReturnPartRow {
  number: number;
  completedAt: string;
  serial: string;
  sku: string;
  priceCents: number;
}

export interface ReturnsRevenueReport {
  parts: ReturnPartRow[];
  totalCents: number;
}

/**
 * The booked-revenue report: Return orders count each part's price as
 * revenue the moment the order completes — the snapshotted line price IS
 * the record, no manual entry (CONTEXT.md: Return Order). Interval on the
 * order's `completed_at`, like every report. A settled line without its
 * price snapshot is an inconsistency and throws.
 */
export function returnsRevenueReport(db: Database.Database, interval: Interval): ReturnsRevenueReport {
  const rows = db
    .prepare(
      `SELECT o.number, o.completed_at, p.serial, s.name AS sku_name, tp.price_cents
         FROM return_order_parts tp
         JOIN return_orders o ON o.id = tp.return_order_id
         JOIN serialized_parts p ON p.id = tp.part_id
         JOIN skus s ON s.id = p.sku_id
        WHERE o.status = 'complete' AND o.completed_at >= ? AND o.completed_at < ?
        ORDER BY o.id, tp.id`
    )
    .all(interval.fromBound, interval.toBound) as Array<{
    number: number;
    completed_at: string | null;
    serial: string;
    sku_name: string;
    price_cents: number | null;
  }>;
  const parts: ReturnPartRow[] = [];
  for (const row of rows) {
    if (row.completed_at === null) {
      throw new Error(
        `return order #${row.number} is complete but has no completed_at — the completion write is inconsistent`
      );
    }
    if (row.price_cents === null) {
      throw new Error(
        `return order #${row.number}: part ${row.serial} settled with no revenue price — the settlement write is inconsistent`
      );
    }
    parts.push({
      number: row.number,
      completedAt: row.completed_at,
      serial: row.serial,
      sku: row.sku_name,
      priceCents: row.price_cents,
    });
  }
  return {
    parts,
    totalCents: parts.reduce((sum, row) => sum + row.priceCents, 0),
  };
}

// ---- batches completed ------------------------------------------------------

export interface CompletedBatchRow {
  number: number;
  closedAt: string;
  closedBy: string;
  repaired: number;
  unrepairable: number;
  additionalIssues: number;
  denied: number;
  totalDevices: number;
}

export interface BatchesCompletedReport {
  batches: CompletedBatchRow[];
  totals: { repaired: number; unrepairable: number; additionalIssues: number; denied: number; totalDevices: number };
}

export function batchesCompletedReport(
  db: Database.Database,
  interval: Interval
): BatchesCompletedReport {
  const rows = db
    .prepare(
      `SELECT b.number, b.closed_at, u.email AS closed_by_email,
              SUM(CASE WHEN d.repair_status = 'Repaired' THEN 1 ELSE 0 END) AS repaired,
              SUM(CASE WHEN d.repair_status = 'Unrepairable' THEN 1 ELSE 0 END) AS unrepairable,
              SUM(CASE WHEN d.repair_status = 'Additional issues present' THEN 1 ELSE 0 END) AS additional,
              SUM(CASE WHEN d.repair_status = 'Denied Repair' THEN 1 ELSE 0 END) AS denied,
              COUNT(*) AS total_devices
         FROM batches b
         JOIN devices d ON d.batch_id = b.id
         LEFT JOIN users u ON u.id = b.closed_by
        WHERE b.status = 'Closed' AND b.closed_at >= ? AND b.closed_at < ?
        GROUP BY b.id
        ORDER BY b.number`
    )
    .all(interval.fromBound, interval.toBound) as Array<{
    number: number;
    closed_at: string | null;
    closed_by_email: string | null;
    repaired: number;
    unrepairable: number;
    additional: number;
    denied: number;
    total_devices: number;
  }>;
  const batches: CompletedBatchRow[] = [];
  for (const row of rows) {
    if (row.closed_at === null || row.closed_by_email === null) {
      throw new Error(
        `batch #${row.number} is Closed but has no close record — the close write is inconsistent`
      );
    }
    batches.push({
      number: row.number,
      closedAt: row.closed_at,
      closedBy: row.closed_by_email,
      repaired: row.repaired,
      unrepairable: row.unrepairable,
      additionalIssues: row.additional,
      denied: row.denied,
      totalDevices: row.total_devices,
    });
  }
  const totals = batches.reduce(
    (acc, batch) => ({
      repaired: acc.repaired + batch.repaired,
      unrepairable: acc.unrepairable + batch.unrepairable,
      additionalIssues: acc.additionalIssues + batch.additionalIssues,
      denied: acc.denied + batch.denied,
      totalDevices: acc.totalDevices + batch.totalDevices,
    }),
    { repaired: 0, unrepairable: 0, additionalIssues: 0, denied: 0, totalDevices: 0 }
  );
  return { batches, totals };
}

// ---- shrink -----------------------------------------------------------------

export interface DamagedPartRow {
  at: string;
  techId: number;
  serial: string;
  sku: string;
  tech: string;
  batch: string;
  priceCents: number;
}

export interface AuditFailureRow {
  at: string;
  serial: string;
  sku: string;
  auditId: number;
  closedBy: string;
  priceCents: number;
}

export interface ShrinkReport {
  damaged: DamagedPartRow[];
  auditFailures: AuditFailureRow[];
  damagedTotalCents: number;
  auditFailureTotalCents: number;
}

/** Reads the Damaged by Tech events once — the shrink report and the per-tech stats share it. */
function damagedByTechEvents(db: Database.Database, interval: Interval): DamagedPartRow[] {
  const events = timelineEvents(
    db,
    "e.action IN ('part.removed', 'part.status_changed') AND e.at >= ? AND e.at < ?",
    [interval.fromBound, interval.toBound]
  );
  const rows: DamagedPartRow[] = [];
  for (const event of events) {
    const payload = event.payload as { to?: unknown; batchNumber?: unknown } | null;
    if (payload?.to !== "damaged_by_tech") {
      continue;
    }
    if (event.actor === null) {
      throw new Error(
        `damaged_by_tech event ${event.id} has no acting user — damage must be attributed to a tech`
      );
    }
    const part = db
      .prepare(
        `SELECT p.serial, s.name AS sku_name, s.price_cents
           FROM serialized_parts p JOIN skus s ON s.id = p.sku_id
          WHERE p.id = ?`
      )
      .get(event.entityId) as { serial: string; sku_name: string; price_cents: number } | undefined;
    if (!part) {
      throw new Error(`damaged part ${event.entityId} no longer exists — the data is inconsistent`);
    }
    rows.push({
      at: event.at,
      techId: event.actor.id,
      serial: part.serial,
      sku: part.sku_name,
      tech: event.actor.email,
      batch: typeof payload.batchNumber === "number" ? `Batch #${payload.batchNumber}` : "",
      priceCents: part.price_cents,
    });
  }
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return rows;
}

export function shrinkReport(db: Database.Database, interval: Interval): ShrinkReport {
  const damaged = damagedByTechEvents(db, interval);
  // Audit failures: the audit's own settlement record, interval on close.
  const auditFailures = (
    db
      .prepare(
        `SELECT a.id AS audit_id, a.closed_at AS at, u.email AS closed_by_email,
                p.serial, s.name AS sku_name, s.price_cents
           FROM audit_parts ap
           JOIN audits a ON a.id = ap.audit_id
           LEFT JOIN users u ON u.id = a.closed_by
           JOIN serialized_parts p ON p.id = ap.part_id
           JOIN skus s ON s.id = p.sku_id
          WHERE ap.outcome = 'failed' AND a.closed_at >= ? AND a.closed_at < ?
          ORDER BY a.id, p.id`
      )
      .all(interval.fromBound, interval.toBound) as Array<{
      audit_id: number;
      at: string | null;
      closed_by_email: string | null;
      serial: string;
      sku_name: string;
      price_cents: number;
    }>
  ).map((row) => {
    if (row.at === null || row.closed_by_email === null) {
      throw new Error(
        `audit #${row.audit_id} has failed parts but no close record — the audit close write is inconsistent`
      );
    }
    return {
      at: row.at,
      serial: row.serial,
      sku: row.sku_name,
      auditId: row.audit_id,
      closedBy: row.closed_by_email,
      priceCents: row.price_cents,
    };
  });
  return {
    damaged,
    auditFailures,
    damagedTotalCents: damaged.reduce((sum, row) => sum + row.priceCents, 0),
    auditFailureTotalCents: auditFailures.reduce((sum, row) => sum + row.priceCents, 0),
  };
}

// ---- per-tech stats ---------------------------------------------------------

export interface TechStatsRow {
  email: string;
  repairs: number;
  /** Average of the hand-entered repair times over the repairs that have one; null when none. */
  averageRepairMinutes: number | null;
  damage: number;
}

export interface TechStatsReport {
  rows: TechStatsRow[];
  totals: { repairs: number; averageRepairMinutes: number | null; damage: number };
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function techStatsReport(db: Database.Database, interval: Interval): TechStatsReport {
  // Repairs completed: the acting tech's own status change to Repaired —
  // Repaired is terminal, so each event is one completed repair.
  const events = timelineEvents(
    db,
    "e.action = 'device.status_changed' AND e.at >= ? AND e.at < ?",
    [interval.fromBound, interval.toBound]
  );
  const stats = new Map<number, { email: string; repairs: number; minutes: number[]; damage: number }>();
  const allMinutes: number[] = [];
  function rowFor(actor: { id: number; email: string }) {
    let row = stats.get(actor.id);
    if (!row) {
      row = { email: actor.email, repairs: 0, minutes: [], damage: 0 };
      stats.set(actor.id, row);
    }
    return row;
  }
  for (const event of events) {
    const payload = event.payload as { to?: unknown } | null;
    if (payload?.to !== "Repaired") {
      continue;
    }
    if (event.actor === null) {
      throw new Error(`device.status_changed event ${event.id} has no acting user`);
    }
    const device = db
      .prepare("SELECT repair_time_minutes FROM devices WHERE id = ?")
      .get(event.entityId) as { repair_time_minutes: number | null } | undefined;
    if (!device) {
      throw new Error(`device ${event.entityId} was marked Repaired but no longer exists`);
    }
    const row = rowFor(event.actor);
    row.repairs += 1;
    if (device.repair_time_minutes !== null) {
      row.minutes.push(device.repair_time_minutes);
      allMinutes.push(device.repair_time_minutes);
    }
  }
  // Damage attributed: the acting tech on each Damaged by Tech event.
  for (const damaged of damagedByTechEvents(db, interval)) {
    rowFor({ id: damaged.techId, email: damaged.tech }).damage += 1;
  }

  const rows: TechStatsRow[] = [...stats.values()]
    .map((entry) => ({
      email: entry.email,
      repairs: entry.repairs,
      averageRepairMinutes: average(entry.minutes),
      damage: entry.damage,
    }))
    .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return {
    rows,
    totals: {
      repairs: rows.reduce((sum, row) => sum + row.repairs, 0),
      // The overall average is over all repairs, never a mean of per-tech means.
      averageRepairMinutes: average(allMinutes),
      damage: rows.reduce((sum, row) => sum + row.damage, 0),
    },
  };
}
