import type Database from "better-sqlite3";
import { formatCents } from "../parts/prices.js";
import { timelineFor } from "../auth/timeline.js";

/**
 * Row types and the API-edge serializers for the purchase-orders domain.
 * Dollars exist only here (formatCents) — storage is integer cents, per
 * the money decision in the spec.
 */

export type PoStatus =
  | "Awaiting approval"
  | "In-transit"
  | "Partially received"
  | "Received"
  | "Closed";

export interface PoRow {
  id: number;
  number: number;
  purpose: string;
  sources: string | null;
  shipping_cost_cents: number;
  status: PoStatus;
  created_at: string;
  created_by: number;
  approved_at: string | null;
  approved_by: number | null;
  closed_at: string | null;
  closed_by: number | null;
  closed_note: string | null;
}

export interface PoLineRow {
  id: number;
  po_id: number;
  sku_id: number;
  quantity: number;
  received_quantity: number;
  unit_price_cents: number;
  source: string | null;
  demand_id: number | null;
  created_at: string;
}

export interface PoTrackingRow {
  id: number;
  po_id: number;
  carrier: string;
  tracking_number: string;
  added_at: string;
  added_by: number;
}

export interface EventRow {
  id: number;
  entity_type: string;
  entity_id: number;
  actor_id: number | null;
  actor_email: string | null;
  at: string;
  action: string;
  payload: string | null;
}

const PO_SELECT = `
  SELECT id, number, purpose, sources, shipping_cost_cents, status,
         created_at, created_by, approved_at, approved_by,
         closed_at, closed_by, closed_note
    FROM purchase_orders
`;

export function getPoRow(db: Database.Database, id: number): PoRow | undefined {
  return db.prepare(`${PO_SELECT} WHERE id = ?`).get(id) as PoRow | undefined;
}

/** The demand records this PO has marked ordered (migration 0006 link table). */
export function getPoDemandIds(db: Database.Database, poId: number): number[] {
  return (
    db
      .prepare("SELECT demand_id FROM purchase_order_demand WHERE po_id = ? ORDER BY demand_id")
      .all(poId) as Array<{ demand_id: number }>
  ).map((row) => row.demand_id);
}

export interface SerializedTracking {
  id: number;
  carrier: string;
  trackingNumber: string;
  addedAt: string;
  addedBy: { id: number; email: string } | null;
}

export function serializeTracking(
  row: PoTrackingRow,
  addedByEmail: string | null
): SerializedTracking {
  return {
    id: row.id,
    carrier: row.carrier,
    trackingNumber: row.tracking_number,
    addedAt: row.added_at,
    addedBy: row.added_by !== null && addedByEmail !== null ? { id: row.added_by, email: addedByEmail } : null,
  };
}

export function trackingFor(db: Database.Database, poId: number): SerializedTracking[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.po_id, t.carrier, t.tracking_number, t.added_at, t.added_by, u.email AS added_by_email
         FROM purchase_order_tracking t LEFT JOIN users u ON u.id = t.added_by
        WHERE t.po_id = ? ORDER BY t.id`
    )
    .all(poId) as Array<PoTrackingRow & { added_by_email: string | null }>;
  return rows.map((row) => serializeTracking(row, row.added_by_email));
}

export interface SerializedLine {
  id: number;
  sku: { id: number; name: string; kind: string };
  quantity: number;
  receivedQuantity: number;
  shortfall: number;
  unitPrice: string;
  unitPriceCents: number;
  source: string | null;
  /**
   * The demand record this line fulfills (ticket 04): its id (the record
   * key), the demanding batch's number, and a human device identifier.
   * The identifier is a read-time join on `devices` — never a stored copy —
   * with the display precedence chosen on ticket 04: Asset ID, else IMEI,
   * else serial number. A batch-only demand (no device) carries device:
   * null; a line that fulfills no demand is null (the page renders "—").
   */
  demand: {
    id: number;
    batchNumber: number;
    device: string | null;
  } | null;
}

export function linesFor(db: Database.Database, poId: number): SerializedLine[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.po_id, l.sku_id, l.quantity, l.received_quantity, l.unit_price_cents, l.source, l.demand_id, l.created_at,
              s.name AS sku_name, s.kind AS sku_kind,
              b2.number AS demand_batch_number,
              dv.imei AS demand_imei, dv.asset_id AS demand_asset_id, dv.serial_number AS demand_serial_number
         FROM purchase_order_lines l JOIN skus s ON s.id = l.sku_id
         LEFT JOIN demand_records dr ON dr.id = l.demand_id
         LEFT JOIN batches b2 ON b2.id = dr.batch_id
         LEFT JOIN devices dv ON dv.id = dr.device_id
        WHERE l.po_id = ? ORDER BY l.id`
    )
    .all(poId) as Array<
    PoLineRow & {
      sku_name: string;
      sku_kind: string;
      demand_batch_number: number | null;
      demand_imei: string | null;
      demand_asset_id: string | null;
      demand_serial_number: string | null;
    }
  >;
  return rows.map((row) => {
    // demand_id is a foreign key into demand_records, whose batch_id and
    // device_id are themselves foreign keys — the joins cannot miss. A miss
    // would mean a broken database, so it fails loudly instead of rendering
    // a silent "—".
    if (row.demand_id !== null && row.demand_batch_number === null) {
      throw new Error(
        `purchase order line ${row.id} references demand ${row.demand_id}, which does not exist`
      );
    }
    const device =
      row.demand_asset_id ?? row.demand_imei ?? row.demand_serial_number ?? null;
    return {
      id: row.id,
      sku: { id: row.sku_id, name: row.sku_name, kind: row.sku_kind },
      quantity: row.quantity,
      receivedQuantity: row.received_quantity,
      shortfall: Math.max(0, row.quantity - row.received_quantity),
      unitPrice: formatCents(row.unit_price_cents),
      unitPriceCents: row.unit_price_cents,
      source: row.source,
      demand:
        row.demand_id === null
          ? null
          : {
              id: row.demand_id,
              batchNumber: row.demand_batch_number as number,
              device,
            },
    };
  });
}

export function poDetail(db: Database.Database, row: PoRow) {
  const lines = linesFor(db, row.id);
  const tracking = trackingFor(db, row.id);
  const linesCents = lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0
  );
  const createdBy = userEmail(db, row.created_by);
  const approvedBy = row.approved_by !== null ? userEmail(db, row.approved_by) : null;
  const closedBy = row.closed_by !== null ? userEmail(db, row.closed_by) : null;
  const expectedSerials = listExpectedSerialsForDetail(db, row.id);
  return {
    id: row.id,
    number: row.number,
    purpose: row.purpose,
    sources: row.sources,
    shippingCost: formatCents(row.shipping_cost_cents),
    shippingCostCents: row.shipping_cost_cents,
    status: row.status,
    createdAt: row.created_at,
    createdBy: { id: row.created_by, email: createdBy },
    approvedAt: row.approved_at,
    approvedBy: approvedBy !== null ? { id: row.approved_by, email: approvedBy } : null,
    closedAt: row.closed_at,
    closedBy: closedBy !== null ? { id: row.closed_by, email: closedBy } : null,
    closedNote: row.closed_note,
    lines,
    tracking,
    expectedSerials,
    lineCount: lines.length,
    trackingCount: tracking.length,
    demandIds: getPoDemandIds(db, row.id),
    totalCents: linesCents + row.shipping_cost_cents,
    total: formatCents(linesCents + row.shipping_cost_cents),
    shortfallTotal: lines.reduce((sum, line) => sum + line.shortfall, 0),
    events: timelineFor(db, "po", row.id),
  };
}

function listExpectedSerialsForDetail(db: Database.Database, poId: number) {
  const rows = db
    .prepare(
      `SELECT e.id, e.line_id, e.serial, e.part_id, e.received_at,
              l.sku_id, s.name AS sku_name, s.kind AS sku_kind
         FROM purchase_order_expected_serials e
         JOIN purchase_order_lines l ON l.id = e.line_id
         JOIN skus s ON s.id = l.sku_id
        WHERE l.po_id = ?
        ORDER BY e.id`
    )
    .all(poId) as Array<{
    id: number;
    line_id: number;
    serial: string;
    part_id: number | null;
    received_at: string | null;
    sku_id: number;
    sku_name: string;
    sku_kind: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    lineId: row.line_id,
    serial: row.serial,
    received: row.part_id !== null,
    partId: row.part_id,
    receivedAt: row.received_at,
    sku: { id: row.sku_id, name: row.sku_name, kind: row.sku_kind },
  }));
}

function userEmail(db: Database.Database, id: number): string {
  const row = db.prepare("SELECT email FROM users WHERE id = ?").get(id) as
    | { email: string }
    | undefined;
  return row?.email ?? "unknown";
}

export interface PoListRow extends PoRow {
  created_by_email: string;
  line_count: number;
  tracking_count: number;
  lines_total_cents: number;
}

export function listPoRows(db: Database.Database): PoListRow[] {
  return db
    .prepare(
      `SELECT po.id, po.number, po.purpose, po.sources, po.shipping_cost_cents, po.status,
              po.created_at, po.created_by, po.approved_at, po.approved_by,
              po.closed_at, po.closed_by, po.closed_note,
              u.email AS created_by_email,
              (SELECT COUNT(*) FROM purchase_order_lines l WHERE l.po_id = po.id) AS line_count,
              (SELECT COUNT(*) FROM purchase_order_tracking t WHERE t.po_id = po.id) AS tracking_count,
              (SELECT COALESCE(SUM(l.quantity * l.unit_price_cents), 0)
                 FROM purchase_order_lines l WHERE l.po_id = po.id) AS lines_total_cents
         FROM purchase_orders po JOIN users u ON u.id = po.created_by
        ORDER BY po.number DESC`
    )
    .all() as PoListRow[];
}

export function serializePoSummary(row: PoListRow) {
  const totalCents = row.lines_total_cents + row.shipping_cost_cents;
  return {
    id: row.id,
    number: row.number,
    purpose: row.purpose,
    sources: row.sources,
    status: row.status,
    createdAt: row.created_at,
    createdBy: { id: row.created_by, email: row.created_by_email },
    lineCount: row.line_count,
    trackingCount: row.tracking_count,
    totalCents,
    total: formatCents(totalCents),
  };
}
