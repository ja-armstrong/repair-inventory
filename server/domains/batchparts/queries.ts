import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";
import { formatCents } from "../parts/prices.js";
import {
  movePartFromReserved,
  partStatusLabel,
} from "../parts/status.js";

/**
 * Row types, queries, and serializers for the parts-on-batches domain
 * (tickets 05 and 06). All money is integer cents in storage; dollars are
 * formatted only at the API edge, exactly like the parts domain does it.
 *
 * Parts Cost is COMPUTED from these rows (`devicePartsCostCents`) and never
 * stored as a hand-entered column. `device_parts.price_cents` is the part's
 * EFFECTIVE price snapshotted at reservation time (ticket 23, CONTEXT.md:
 * Part Price — the unit's own override ?? its SKU's price), so a device's
 * cost is stable against later catalog price changes (approval signs off a
 * number that will not move underneath it). The ticket-06 additions below —
 * retriage carry-over
 * and close settlement — are the domain's OWN guarded writes that the
 * batches lifecycle calls into, keeping table ownership honest. The
 * serialized_parts.status writes here route through the parts domain's
 * guarded primitives (ticket 14) — one seam for the part lifecycle.
 */

export interface BatchDeviceRow {
  id: number;
  batch_id: number;
  repair_status: string;
  batch_status: string;
  batch_number: number;
}

export function getBatchDevice(
  db: Database.Database,
  batchId: number,
  deviceId: number
): BatchDeviceRow | undefined {
  // Ticket 30: a REMOVED device is invisible to part edits — the row exists
  // for history, but nothing may attach to or detach from it.
  return db
    .prepare(
      `SELECT d.id, d.batch_id, d.repair_status, b.status AS batch_status, b.number AS batch_number
         FROM devices d JOIN batches b ON b.id = d.batch_id
        WHERE d.id = ? AND d.batch_id = ? AND d.removed_at IS NULL`
    )
    .get(deviceId, batchId) as BatchDeviceRow | undefined;
}

export interface SkuRow {
  id: number;
  name: string;
  price_cents: number;
  kind: "serialized" | "consumable";
}

export function getSkuRow(db: Database.Database, id: number): SkuRow | undefined {
  return db
    .prepare("SELECT id, name, price_cents, kind FROM skus WHERE id = ?")
    .get(id) as SkuRow | undefined;
}

/**
 * The batch number for timeline payloads. LOUD on a missing batch (review
 * finding S4): fabricating a number would falsify immutable timeline events,
 * so a caller that reaches here without a batch row is a bug that fails.
 */
export function getBatchNumber(db: Database.Database, batchId: number): number {
  const row = db.prepare("SELECT number FROM batches WHERE id = ?").get(batchId) as
    | { number: number }
    | undefined;
  if (!row) {
    throw new Error(`no batch with id ${batchId} — refusing to fabricate a batch number for the timeline`);
  }
  return row.number;
}

export interface PartSummaryRow {
  id: number;
  serial: string;
  status: string;
  /** The unit's own price override (ticket 23); NULL = follow the SKU price. */
  price_cents: number | null;
  /** The unit's SKU — the scan paths match it against the attachment's SKU. */
  sku_id: number;
}

export function getPartById(db: Database.Database, id: number): PartSummaryRow | undefined {
  return db
    .prepare("SELECT id, serial, status, price_cents, sku_id FROM serialized_parts WHERE id = ?")
    .get(id) as PartSummaryRow | undefined;
}

export function getPartBySerial(db: Database.Database, serial: string): PartSummaryRow | undefined {
  return db
    .prepare("SELECT id, serial, status, price_cents, sku_id FROM serialized_parts WHERE serial = ?")
    .get(serial) as PartSummaryRow | undefined;
}

/**
 * The scan lookup (the scan-to-add / scanned-swap paths): a part by serial
 * WITH its SKU row — a scanned serial names BOTH the exact unit and the part
 * kind, so the caller never guesses and never needs a separate SKU pick.
 */
export interface ScannablePartRow {
  id: number;
  serial: string;
  status: string;
  price_cents: number | null;
  sku_id: number;
  sku_name: string;
  sku_price_cents: number;
}

export function getScannablePart(
  db: Database.Database,
  serial: string
): ScannablePartRow | undefined {
  return db
    .prepare(
      `SELECT p.id, p.serial, p.status, p.price_cents, p.sku_id,
              s.name AS sku_name, s.price_cents AS sku_price_cents
         FROM serialized_parts p JOIN skus s ON s.id = p.sku_id
        WHERE p.serial = ?`
    )
    .get(serial) as ScannablePartRow | undefined;
}

/**
 * The reservation pick: the oldest Available unit of a SKU (intake order —
 * id order). Called INSIDE the reservation transaction so the pick, the
 * status flip, and the attachment row are one atomic write. The guarded
 * status flip itself is `reservePart` from the parts domain's status module
 * (ticket 14) — the one writer of a part becoming Reserved. The unit's own
 * price override rides along (ticket 23): the attachment snapshot is the
 * unit's EFFECTIVE price (override ?? SKU price), not blindly the catalog.
 */
export function oldestAvailablePart(
  db: Database.Database,
  skuId: number
): PartSummaryRow | undefined {
  return db
    .prepare(
      "SELECT id, serial, status, price_cents, sku_id FROM serialized_parts WHERE sku_id = ? AND status = 'available' ORDER BY id LIMIT 1"
    )
    .get(skuId) as PartSummaryRow | undefined;
}

// ---- attachments -----------------------------------------------------------

const ATTACHMENT_SELECT = `
  SELECT dp.id, dp.device_id, dp.part_id, dp.price_cents, dp.added_at, dp.added_by,
         dp.removed_at, dp.removed_by, dp.removed_to, dp.removal_note, dp.removal_reason,
         p.serial AS part_serial, p.status AS part_status, p.price_cents AS part_price_cents,
         s.id AS sku_id, s.name AS sku_name, s.kind AS sku_kind, s.price_cents AS sku_price_cents,
         s.buybackable AS sku_buybackable,
         ua.email AS added_by_email, ur.email AS removed_by_email
    FROM device_parts dp
    JOIN serialized_parts p ON p.id = dp.part_id
    JOIN skus s ON s.id = p.sku_id
    JOIN users ua ON ua.id = dp.added_by
    LEFT JOIN users ur ON ur.id = dp.removed_by
`;

export interface AttachmentJoinRow {
  id: number;
  device_id: number;
  part_id: number;
  price_cents: number;
  added_at: string;
  added_by: number;
  removed_at: string | null;
  removed_by: number | null;
  removed_to: string | null;
  removal_note: string | null;
  removal_reason: string | null;
  part_serial: string;
  part_status: string;
  part_price_cents: number | null;
  sku_id: number;
  sku_name: string;
  sku_kind: string;
  sku_price_cents: number;
  sku_buybackable: number;
  added_by_email: string;
  removed_by_email: string | null;
}

export function getAttachment(
  db: Database.Database,
  id: number
): AttachmentJoinRow | undefined {
  return db.prepare(`${ATTACHMENT_SELECT} WHERE dp.id = ?`).get(id) as
    | AttachmentJoinRow
    | undefined;
}

export function listAttachmentsForBatch(
  db: Database.Database,
  batchId: number
): AttachmentJoinRow[] {
  return db
    .prepare(`${ATTACHMENT_SELECT} WHERE dp.device_id IN (SELECT id FROM devices WHERE batch_id = ?) ORDER BY dp.id`)
    .all(batchId) as AttachmentJoinRow[];
}

/** Active (unremoved) attachments of ONE device — the retriage carry-over set. */
export function listActiveAttachmentsForDevice(
  db: Database.Database,
  deviceId: number
): AttachmentJoinRow[] {
  return db
    .prepare(`${ATTACHMENT_SELECT} WHERE dp.device_id = ? AND dp.removed_at IS NULL ORDER BY dp.id`)
    .all(deviceId) as AttachmentJoinRow[];
}

export function serializeAttachment(row: AttachmentJoinRow) {
  return {
    id: row.id,
    device: { id: row.device_id },
    part: {
      id: row.part_id,
      serial: row.part_serial,
      status: row.part_status,
      statusLabel: partStatusLabel(row.part_status),
    },
    sku: {
      id: row.sku_id,
      name: row.sku_name,
      kind: row.sku_kind,
      price: formatCents(row.sku_price_cents),
      priceCents: row.sku_price_cents,
      // Tickets 27 + 02: the flag is DISPLAY-ONLY (the parts panel may badge
      // a Buybackable SKU; the SKU page shows the flag). The removal
      // destination is ALWAYS the tech's explicit choice — nothing
      // pre-selects it, and the server applies no default.
      buybackable: row.sku_buybackable === 1,
    },
    priceCents: row.price_cents,
    price: formatCents(row.price_cents),
    // Ticket 23: the flag is the PART's own price-override state (its
    // serialized_parts.price_cents is set), not a snapshot/SKU comparison —
    // a SKU repriced after reservation must not read as an override.
    priceOverridden: row.part_price_cents !== null,
    addedAt: row.added_at,
    addedBy: { id: row.added_by, email: row.added_by_email },
    removedAt: row.removed_at,
    removedBy: row.removed_by === null ? null : { id: row.removed_by, email: row.removed_by_email },
    removedTo: row.removed_to,
    removalNote: row.removal_note,
    removalReason: row.removal_reason,
  };
}

export function serializePartSummary(row: PartSummaryRow) {
  return {
    id: row.id,
    serial: row.serial,
    status: row.status,
    statusLabel: partStatusLabel(row.status),
  };
}

export function insertAttachment(
  db: Database.Database,
  params: {
    deviceId: number;
    partId: number;
    priceCents: number;
    addedAt: string;
    addedBy: number;
  }
): number {
  const result = db
    .prepare(
      "INSERT INTO device_parts (device_id, part_id, price_cents, added_at, added_by) VALUES (?, ?, ?, ?, ?)"
    )
    .run(params.deviceId, params.partId, params.priceCents, params.addedAt, params.addedBy);
  return Number(result.lastInsertRowid);
}

/**
 * Closes an attachment with the full removal record — WHEN, WHO, WHERE the
 * part went, WHY (note, required), and the KIND of removal. The CHECK
 * constraint in migration 0005 (extended by 0012 for audit settlements)
 * refuses a half-filled removal, so a silent return to stock is impossible
 * at the schema level as well.
 */
export function closeAttachment(
  db: Database.Database,
  id: number,
  params: {
    removedAt: string;
    removedBy: number;
    removedTo: "available" | "rma" | "damaged_by_tech" | "unavailable" | "buyback";
    removalNote: string;
    removalReason: "removal" | "swap" | "audit";
  }
): void {
  db.prepare(
    "UPDATE device_parts SET removed_at = ?, removed_by = ?, removed_to = ?, removal_note = ?, removal_reason = ? WHERE id = ?"
  ).run(params.removedAt, params.removedBy, params.removedTo, params.removalNote, params.removalReason, id);
}

// ---- consumable usage ------------------------------------------------------

const CONSUMABLE_SELECT = `
  SELECT c.id, c.device_id, c.sku_id, c.quantity, c.unit_price_cents, c.recorded_at, c.recorded_by,
         c.removed_at,
         s.name AS sku_name, s.kind AS sku_kind, s.price_cents AS sku_price_cents,
         u.email AS recorded_by_email
    FROM device_consumables c
    JOIN skus s ON s.id = c.sku_id
    JOIN users u ON u.id = c.recorded_by
`;

export interface ConsumableJoinRow {
  id: number;
  device_id: number;
  sku_id: number;
  quantity: number;
  unit_price_cents: number;
  recorded_at: string;
  recorded_by: number;
  removed_at: string | null;
  sku_name: string;
  sku_kind: string;
  sku_price_cents: number;
  recorded_by_email: string;
}

/**
 * The device's ACTIVE consumable usage — a removed usage is a cost
 * correction kept on its row (removed_at/by/note, migration 0021) and in the
 * timeline, but it no longer counts toward Parts Cost, so it is not listed.
 */
export function listConsumablesForBatch(
  db: Database.Database,
  batchId: number
): ConsumableJoinRow[] {
  return db
    .prepare(
      `${CONSUMABLE_SELECT} WHERE c.device_id IN (SELECT id FROM devices WHERE batch_id = ?) AND c.removed_at IS NULL ORDER BY c.id`
    )
    .all(batchId) as ConsumableJoinRow[];
}

/**
 * The guarded consumable-usage removal write (migration 0021): the row is
 * soft-removed only when still ACTIVE — a raced removal fails loudly rather
 * than overwriting. All three removal fields are written together (the
 * all-or-nothing rule the schema cannot CHECK after an ALTER).
 */
export function removeConsumableRow(
  db: Database.Database,
  id: number,
  params: { removedAt: string; removedBy: number; removalNote: string }
): boolean {
  return (
    db
      .prepare(
        "UPDATE device_consumables SET removed_at = ?, removed_by = ?, removal_note = ? WHERE id = ? AND removed_at IS NULL"
      )
      .run(params.removedAt, params.removedBy, params.removalNote, id).changes === 1
  );
}

export function getConsumableUsage(db: Database.Database, id: number): ConsumableJoinRow | undefined {
  return db.prepare(`${CONSUMABLE_SELECT} WHERE c.id = ?`).get(id) as ConsumableJoinRow | undefined;
}

export function serializeConsumable(row: ConsumableJoinRow) {
  return {
    id: row.id,
    sku: { id: row.sku_id, name: row.sku_name, kind: row.sku_kind },
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    costCents: row.quantity * row.unit_price_cents,
    recordedAt: row.recorded_at,
    recordedBy: { id: row.recorded_by, email: row.recorded_by_email },
  };
}

export function insertConsumableUsage(
  db: Database.Database,
  params: {
    deviceId: number;
    skuId: number;
    quantity: number;
    unitPriceCents: number;
    recordedAt: string;
    recordedBy: number;
  }
): number {
  const result = db
    .prepare(
      "INSERT INTO device_consumables (device_id, sku_id, quantity, unit_price_cents, recorded_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(
      params.deviceId,
      params.skuId,
      params.quantity,
      params.unitPriceCents,
      params.recordedAt,
      params.recordedBy
    );
  return Number(result.lastInsertRowid);
}

// ---- Need to Order demand --------------------------------------------------

const DEMAND_SELECT = `
  SELECT r.id, r.sku_id, r.batch_id, r.device_id, r.supplier, r.status, r.created_at, r.created_by,
         s.name AS sku_name, s.kind AS sku_kind, s.price_cents AS sku_price_cents,
         s.default_source_url AS sku_default_source_url,
         b.number AS batch_number, u.email AS created_by_email,
         (SELECT po.number FROM purchase_order_demand pod
            JOIN purchase_orders po ON po.id = pod.po_id
           WHERE pod.demand_id = r.id ORDER BY pod.po_id LIMIT 1) AS ordered_po_number,
         (SELECT po.status FROM purchase_order_demand pod
            JOIN purchase_orders po ON po.id = pod.po_id
           WHERE pod.demand_id = r.id ORDER BY pod.po_id LIMIT 1) AS ordered_po_status
    FROM demand_records r
    JOIN skus s ON s.id = r.sku_id
    JOIN batches b ON b.id = r.batch_id
    JOIN users u ON u.id = r.created_by
`;

export interface DemandJoinRow {
  id: number;
  sku_id: number;
  batch_id: number;
  device_id: number | null;
  supplier: string | null;
  status: string;
  created_at: string;
  created_by: number;
  sku_name: string;
  sku_kind: string;
  sku_price_cents: number;
  /** Ticket 11: the SKU's default source link — the prefill source for PO
   * lines and new demand suppliers; NULL when the SKU has none. */
  sku_default_source_url: string | null;
  batch_number: number;
  created_by_email: string;
  ordered_po_number: number | null;
  ordered_po_status: string | null;
}

export function getDemandRow(db: Database.Database, id: number): DemandJoinRow | undefined {
  return db.prepare(`${DEMAND_SELECT} WHERE r.id = ?`).get(id) as DemandJoinRow | undefined;
}

export function listDemandForBatch(db: Database.Database, batchId: number): DemandJoinRow[] {
  return db
    .prepare(`${DEMAND_SELECT} WHERE r.batch_id = ? ORDER BY r.id`)
    .all(batchId) as DemandJoinRow[];
}

/**
 * THE one definition of outstanding Need to Order demand (final review F1 /
 * architecture C): open records, on an APPROVED (Open) batch, that no
 * purchase order has marked ordered. `purchase_order_demand` (migration
 * 0006) is the purchaseorders domain's link table of ordered demand ids;
 * reading it here keeps a single source of truth — GET /api/demand and
 * GET /api/purchase-orders/demand both serve this query, so they can never
 * disagree. Ordering only hides a demand from the queue; receipt flips the
 * record to fulfilled.
 *
 * The Open-batch condition is the approval gate for ORDERING: a
 * pre-approval batch's demand is an estimate — the manager has not signed
 * off that cost yet, so it must not be orderable (and a receipt would
 * auto-reserve parts onto a batch whose approval never happened). A Closed
 * batch is excluded too: its record is finished.
 */
export function listOutstandingDemand(db: Database.Database): DemandJoinRow[] {
  return db
    .prepare(
      `${DEMAND_SELECT}
        WHERE r.status = 'open'
          AND b.status = 'Open'
          AND r.id NOT IN (SELECT demand_id FROM purchase_order_demand)
        ORDER BY r.id`
    )
    .all() as DemandJoinRow[];
}

export function serializeDemand(row: DemandJoinRow) {
  return {
    id: row.id,
    // The SKU's current price rides along: a Need to Order has no unit yet,
    // so the SKU default is the only cost estimate approval can see.
    sku: { id: row.sku_id, name: row.sku_name, kind: row.sku_kind, priceCents: row.sku_price_cents },
    batch: { id: row.batch_id, number: row.batch_number },
    device: row.device_id === null ? null : { id: row.device_id },
    supplier: row.supplier,
    status: row.status,
    createdAt: row.created_at,
    createdBy: { id: row.created_by, email: row.created_by_email },
    // Ticket 29: a demand already marked ordered is not "needed" any more —
    // it is in transit on its purchase order. The batch shows this instead
    // of the stale Need-to-Order wording; receipt flips the record to
    // fulfilled through the purchaseorders seam.
    orderedOn:
      row.ordered_po_number === null
        ? null
        : { poNumber: row.ordered_po_number, poStatus: row.ordered_po_status },
  };
}

export function insertDemand(
  db: Database.Database,
  params: {
    skuId: number;
    batchId: number;
    deviceId: number | null;
    supplier: string | null;
    createdAt: string;
    createdBy: number;
  }
): number {
  const result = db
    .prepare(
      "INSERT INTO demand_records (sku_id, batch_id, device_id, supplier, status, created_at, created_by) VALUES (?, ?, ?, ?, 'open', ?, ?)"
    )
    .run(
      params.skuId,
      params.batchId,
      params.deviceId,
      params.supplier,
      params.createdAt,
      params.createdBy
    );
  return Number(result.lastInsertRowid);
}

/**
 * The device's still-open Need to Order records (ticket 30): the population a
 * device removal cancels. Guarded by status 'open' — fulfilled and already-
 * cancelled records are history, never touched.
 */
export function listOpenDemandForDevice(db: Database.Database, deviceId: number): DemandJoinRow[] {
  return db
    .prepare(`${DEMAND_SELECT} WHERE r.device_id = ? AND r.status = 'open' ORDER BY r.id`)
    .all(deviceId) as DemandJoinRow[];
}

/**
 * Cancel ONE open demand record (guarded: only an 'open' row flips; the
 * caller throws on a zero-change, so a raced fulfilment fails the whole
 * removal transaction rather than half-writing).
 */
export function cancelDemand(
  db: Database.Database,
  demandId: number,
  params: { cancelledAt: string; cancelledBy: number }
): boolean {
  const changed = db
    .prepare(
      `UPDATE demand_records
          SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?
        WHERE id = ? AND status = 'open'`
    )
    .run(params.cancelledAt, params.cancelledBy, demandId).changes;
  return changed === 1;
}

/**
 * Cancel ONE open demand record and record its event pair (the shared
 * vocabulary: `demand.cancelled` on the demand, `device.demand_cancelled`
 * on the device) — the ONE cancel path, used by the manual cancel endpoint
 * and the device-removal flow alike. Guarded: only an 'open' row flips;
 * the throw on a zero-change fails the caller's whole transaction rather
 * than half-writing.
 */
export function cancelDemandWithEvents(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  params: {
    demandId: number;
    skuId: number;
    sku: string;
    batchId: number;
    batchNumber: number;
    deviceId: number;
    note: string;
    /** What brought about the cancellation (device removal names itself). */
    reason?: string;
  }
): void {
  if (
    !cancelDemand(db, params.demandId, {
      cancelledAt: clock.now().toISOString(),
      cancelledBy: actor.id,
    })
  ) {
    throw new Error(
      `demand record ${params.demandId} left 'open' mid-transaction — refusing a half-cancelled write`
    );
  }
  recordEvent(db, clock, {
    entityType: "demand",
    entityId: params.demandId,
    actorId: actor.id,
    action: "demand.cancelled",
    payload: {
      skuId: params.skuId,
      sku: params.sku,
      batchId: params.batchId,
      batchNumber: params.batchNumber,
      deviceId: params.deviceId,
      ...(params.reason ? { reason: params.reason } : {}),
      note: params.note,
    },
  });
  recordEvent(db, clock, {
    entityType: "device",
    entityId: params.deviceId,
    actorId: actor.id,
    action: "device.demand_cancelled",
    payload: { demandId: params.demandId, skuId: params.skuId, sku: params.sku, note: params.note },
  });
}

// ---- a part's attachment history (all batches, past included) --------------

const PART_ATTACHMENT_SELECT = `
  SELECT dp.id, dp.price_cents, dp.added_at, dp.added_by, dp.removed_at, dp.removed_by,
         dp.removed_to, dp.removal_note, dp.removal_reason, dp.device_id,
         d.batch_id, b.number AS batch_number, m.name AS device_model,
         ua.email AS added_by_email, ur.email AS removed_by_email
    FROM device_parts dp
    JOIN devices d ON d.id = dp.device_id
    JOIN batches b ON b.id = d.batch_id
    JOIN device_models m ON m.id = d.model_id
    JOIN users ua ON ua.id = dp.added_by
    LEFT JOIN users ur ON ur.id = dp.removed_by
   WHERE dp.part_id = ?
   ORDER BY dp.id
`;

export interface PartAttachmentJoinRow {
  id: number;
  price_cents: number;
  added_at: string;
  added_by: number;
  removed_at: string | null;
  removed_by: number | null;
  removed_to: string | null;
  removal_note: string | null;
  removal_reason: string | null;
  device_id: number;
  batch_id: number;
  batch_number: number;
  device_model: string;
  added_by_email: string;
  removed_by_email: string | null;
}

export function listAttachmentsForPart(
  db: Database.Database,
  partId: number
): PartAttachmentJoinRow[] {
  return db.prepare(PART_ATTACHMENT_SELECT).all(partId) as PartAttachmentJoinRow[];
}

export function serializePartAttachment(row: PartAttachmentJoinRow) {
  return {
    id: row.id,
    batch: { id: row.batch_id, number: row.batch_number },
    device: { id: row.device_id, model: row.device_model },
    priceCents: row.price_cents,
    price: formatCents(row.price_cents),
    addedAt: row.added_at,
    addedBy: { id: row.added_by, email: row.added_by_email },
    removedAt: row.removed_at,
    removedBy: row.removed_by === null ? null : { id: row.removed_by, email: row.removed_by_email },
    removedTo: row.removed_to,
    removalNote: row.removal_note,
    removalReason: row.removal_reason,
  };
}

// ---- the computed Parts Cost ------------------------------------------------

/**
 * Parts Cost per spec story 37: serialized attachments at their snapshotted
 * price plus consumable quantity × unit price. COMPUTED, never stored.
 */
export function devicePartsCostCents(db: Database.Database, deviceId: number): number {
  const parts = db
    .prepare(
      "SELECT COALESCE(SUM(price_cents), 0) AS c FROM device_parts WHERE device_id = ? AND removed_at IS NULL"
    )
    .get(deviceId) as { c: number };
  const consumables = db
    .prepare(
      "SELECT COALESCE(SUM(quantity * unit_price_cents), 0) AS c FROM device_consumables WHERE device_id = ? AND removed_at IS NULL"
    )
    .get(deviceId) as { c: number };
  return parts.c + consumables.c;
}

/**
 * The device's price add limit (ticket 28, CONTEXT.md: Approval) — the
 * post-approval spend a tech may add without further approval. 0 = no
 * headroom (today's pre-ticket behavior); the column is NOT NULL.
 */
export function devicePriceAddLimitCents(db: Database.Database, deviceId: number): number {
  const row = db
    .prepare("SELECT price_add_limit_cents FROM devices WHERE id = ?")
    .get(deviceId) as { price_add_limit_cents: number } | undefined;
  if (!row) {
    throw new Error(`no device with id ${deviceId} — refusing to invent a price add limit`);
  }
  return row.price_add_limit_cents;
}

/**
 * The device's post-approval spend, DERIVED — never stored (ticket 28). It
 * is the snapshot-cost sum of the device's ACTIVE attachments created
 * strictly AFTER the batch's approved_at, plus consumable usage recorded
 * after it:
 * - pre-approval additions are covered by the approved total and never
 *   count (the approved_at comparison is the whole rule);
 * - a swap's removed attachment is no longer active, so it drops out, while
 *   the replacement (added after approval) counts — mirroring Parts Cost;
 * - price overrides count at their effective price, because the snapshot
 *   IS the effective price (ticket 23).
 *
 * Loud on inconsistency: an Open batch without an approved_at would make
 * every comparison silently false — throw instead.
 */
export function devicePostApprovalSpendCents(db: Database.Database, deviceId: number): number {
  const batch = db
    .prepare(
      `SELECT b.approved_at, b.status
         FROM devices d JOIN batches b ON b.id = d.batch_id
        WHERE d.id = ?`
    )
    .get(deviceId) as { approved_at: string | null; status: string } | undefined;
  if (!batch) {
    throw new Error(`no device with id ${deviceId} — refusing to derive spend for a missing device`);
  }
  if (batch.status === "Open" && batch.approved_at === null) {
    throw new Error(
      `device ${deviceId} sits on an Open batch with no approved_at — the derived spend would be silently wrong`
    );
  }
  const parts = db
    .prepare(
      `SELECT COALESCE(SUM(dp.price_cents), 0) AS c
         FROM device_parts dp
         JOIN devices d ON d.id = dp.device_id
         JOIN batches b ON b.id = d.batch_id
        WHERE dp.device_id = ? AND dp.removed_at IS NULL AND dp.added_at > b.approved_at`
    )
    .get(deviceId) as { c: number };
  const consumables = db
    .prepare(
      `SELECT COALESCE(SUM(c.quantity * c.unit_price_cents), 0) AS c
         FROM device_consumables c
         JOIN devices d ON d.id = c.device_id
         JOIN batches b ON b.id = d.batch_id
        WHERE c.device_id = ? AND c.removed_at IS NULL AND c.recorded_at > b.approved_at`
    )
    .get(deviceId) as { c: number };
  return parts.c + consumables.c;
}

export function deviceIdsForBatch(db: Database.Database, batchId: number): number[] {
  // Ticket 30: removed devices are not part of the batch's live grid.
  const rows = db
    .prepare("SELECT id FROM devices WHERE batch_id = ? AND removed_at IS NULL ORDER BY id")
    .all(batchId) as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

// ---- retriage carry-over and close settlement (ticket 06) -------------------

/**
 * Retriage carry-over: repoint a device's ACTIVE attachments to its
 * continuation row on the new batch. The parts stay Reserved and keep their
 * snapshotted prices — only the device row (and with it, the batch whose
 * approval covers them) changes. Returns the number of attachments moved.
 */
export function moveAttachmentsToDevice(
  db: Database.Database,
  fromDeviceId: number,
  toDeviceId: number
): number {
  return db
    .prepare(
      "UPDATE device_parts SET device_id = ? WHERE device_id = ? AND removed_at IS NULL"
    )
    .run(toDeviceId, fromDeviceId).changes;
}

/**
 * Retriage carry-over for Need to Order demand: an open demand is a need
 * that still exists, so it follows the device onto the new batch — otherwise
 * a receipt would auto-reserve a part onto a terminal device row on a
 * possibly-closed batch. Fulfilled demand stays where it was (history).
 */
export function moveOpenDemandToDevice(
  db: Database.Database,
  fromDeviceId: number,
  toBatchId: number,
  toDeviceId: number
): number {
  return db
    .prepare(
      "UPDATE demand_records SET batch_id = ?, device_id = ? WHERE device_id = ? AND status = 'open'"
    )
    .run(toBatchId, toDeviceId, fromDeviceId).changes;
}

export interface BatchSettlement {
  /**
   * Active attachments whose Reserved unit was settled (Repaired: Buyback
   * for a Buybackable SKU / Unavailable otherwise; Unrepairable: Available;
   * other terminal statuses: Unavailable — see settleBatchParts).
   */
  settled: AttachmentJoinRow[];
  /**
   * Active attachments whose part was NOT Reserved at close time (e.g. an
   * audit close moved it first). Nothing was written; the batch.closed
   * event lists them so the settlement is never silent.
   */
  alreadyUnavailable: AttachmentJoinRow[];
}

/**
 * Return a device's active attachments to stock (destination Available): the
 * denial return at approval (ticket 25, reason batch_denied) and the device
 * removal (ticket 30, reason device_removed) share this one write — parts are
 * unneeded, not damaged; a genuinely damaged unit is removed manually
 * beforehand. The auto-note names the act; the schema's removal vocabulary
 * is about how an attachment ENDED, and both are removals.
 *
 * Runs inside the caller's transaction. A part that is not Reserved while its
 * attachment is active is a data inconsistency — throw loudly rather than
 * write a half-truth.
 */
export function returnAttachmentsToStock(
  db: Database.Database,
  clock: Clock,
  actorId: number,
  params: {
    deviceId: number;
    batchId: number;
    batchNumber: number;
    note: string;
    reason: "batch_denied" | "device_removed";
  }
): AttachmentJoinRow[] {
  const attachments = listActiveAttachmentsForDevice(db, params.deviceId);
  for (const attachment of attachments) {
    if (!movePartFromReserved(db, attachment.part_id, "available")) {
      throw new Error(
        `part ${attachment.part_serial} on denied device ${params.deviceId} is ${attachment.part_status}, not reserved — refusing the unguarded return to stock`
      );
    }
    closeAttachment(db, attachment.id, {
      removedAt: clock.now().toISOString(),
      removedBy: actorId,
      removedTo: "available",
      removalNote: params.note,
      removalReason: "removal",
    });
    recordEvent(db, clock, {
      entityType: "part",
      entityId: attachment.part_id,
      actorId,
      action: "part.removed",
      payload: {
        serial: attachment.part_serial,
        skuId: attachment.sku_id,
        sku: attachment.sku_name,
        batchId: params.batchId,
        batchNumber: params.batchNumber,
        deviceId: params.deviceId,
        from: "reserved",
        to: "available",
        reason: params.reason,
        note: params.note,
      },
    });
    recordEvent(db, clock, {
      entityType: "device",
      entityId: params.deviceId,
      actorId,
      action: "device.part_removed",
      payload: {
        serial: attachment.part_serial,
        skuId: attachment.sku_id,
        sku: attachment.sku_name,
        destination: "available",
        note: params.note,
      },
    });
  }
  return attachments;
}

/**
 * Close settlement (spec stories 38–39; ticket 03 made it status-aware):
 * every still-active attachment's part is settled by its DEVICE's terminal
 * Repair Status — the device decides where the part goes, because the device
 * knows what happened to it:
 *
 * - **Repaired**: the applied part WAS the repair. A Buybackable SKU's unit
 *   is the replaced screen worth money back → Buyback; any other SKU has no
 *   recoverable value → Unavailable.
 * - **Unrepairable**: the repair is "reversed" — nothing was replaced, so
 *   the applied part is good stock going home → Available, Buybackable or
 *   not (buyback value exists only for broken REPLACED parts).
 * - **Additional issues present / Denied Repair**: no settlement decision —
 *   retriage already moved their attachments to the continuation device and
 *   denial returned their parts at approval, so normally nothing is left.
 *   A leftover keeps the pre-ticket-03 path (Unavailable) or, if its part
 *   already left Reserved, the loud `alreadyUnavailable` listing — never a
 *   silent guess about where it belongs.
 *
 * In this schema a part is Reserved only through an active device_parts
 * attachment, so the batch's active attachments ARE its reserved population
 * — there is no unattached "uninstalled reserved" part to return to Available
 * (removals already chose a destination at removal time).
 *
 * Runs inside the caller's close transaction; each part's flip is guarded so
 * a part that raced out of Reserved is reported, not overwritten. Each
 * settled part's event `reason` names WHY it moved
 * (batch_closed_repaired_buyback / batch_closed_repaired_unavailable /
 * batch_closed_unrepairable_available / batch_closed) so the timeline
 * distinguishes close outcomes; system events, no user note.
 */

/**
 * The close-settlement event reasons (ticket 03): system events, no user
 * note, each naming WHY the part left Reserved. Exported because the reports
 * domain reads these events — a part whose close settlement ended it
 * Unavailable is a CONSUMED part, and the expense report's non-purchased
 * consumption listing keys off exactly these reasons (the expense total
 * itself counts PO receipts, not consumption). This constant is the
 * vocabulary's single source.
 */
export const BATCH_CLOSE_REASONS = {
  repairedBuyback: "batch_closed_repaired_buyback",
  repairedUnavailable: "batch_closed_repaired_unavailable",
  unrepairableAvailable: "batch_closed_unrepairable_available",
  /** Leftover attachments on Additional-issues / Denied-Repair devices. */
  leftoverUnavailable: "batch_closed",
} as const;

/**
 * The one close-settlement decision (spec decision 2): device status and the
 * SKU's buybackable flag → the part destination and the event reason that
 * says why. Single source of truth — the settlement loop only executes it.
 */
function closeSettlementFor(
  repairStatus: string,
  buybackable: boolean
): { status: "buyback" | "unavailable" | "available"; reason: string } {
  if (repairStatus === "Repaired") {
    return buybackable
      ? { status: "buyback", reason: BATCH_CLOSE_REASONS.repairedBuyback }
      : { status: "unavailable", reason: BATCH_CLOSE_REASONS.repairedUnavailable };
  }
  if (repairStatus === "Unrepairable") {
    return { status: "available", reason: BATCH_CLOSE_REASONS.unrepairableAvailable };
  }
  return { status: "unavailable", reason: BATCH_CLOSE_REASONS.leftoverUnavailable };
}

export function settleBatchParts(
  db: Database.Database,
  clock: Clock,
  actorId: number,
  batchId: number,
  batchNumber: number
): BatchSettlement {
  const attachments = listAttachmentsForBatch(db, batchId).filter(
    (row) => row.removed_at === null
  );
  // One read for the whole batch: the device's terminal Repair Status is the
  // settlement's decision input. An attachment whose device has no row is an
  // inconsistency (AGENTS.md: fail loudly) — guessing a destination would
  // write a half-truth into inventory.
  const deviceStatuses = new Map(
    (
      db
        .prepare("SELECT id, repair_status FROM devices WHERE batch_id = ?")
        .all(batchId) as Array<{ id: number; repair_status: string }>
    ).map((row) => [row.id, row.repair_status])
  );
  const settled: AttachmentJoinRow[] = [];
  const alreadyUnavailable: AttachmentJoinRow[] = [];
  for (const attachment of attachments) {
    const repairStatus = deviceStatuses.get(attachment.device_id);
    if (repairStatus === undefined) {
      throw new Error(
        `attachment ${attachment.id} names device ${attachment.device_id}, which has no row on batch ${batchId} — refusing to guess its close settlement`
      );
    }
    const destination = closeSettlementFor(repairStatus, attachment.sku_buybackable === 1);
    // Through the parts domain's guarded primitive (ticket 14): the flip
    // happens only if the part is still Reserved — a part that raced out of
    // Reserved is reported, not overwritten. The primitive also enforces the
    // buybackable rule for the Buyback destination (the settlement only asks
    // for Buyback on a Buybackable SKU; the guard is the backstop).
    const changed = movePartFromReserved(db, attachment.part_id, destination.status);
    if (changed) {
      settled.push(attachment);
      recordEvent(db, clock, {
        entityType: "part",
        entityId: attachment.part_id,
        actorId,
        action: "part.status_changed",
        payload: {
          serial: attachment.part_serial,
          sku: attachment.sku_name,
          from: "reserved",
          to: destination.status,
          reason: destination.reason,
          batchId,
          batchNumber,
          deviceId: attachment.device_id,
        },
      });
    } else {
      alreadyUnavailable.push(attachment);
    }
  }
  return { settled, alreadyUnavailable };
}

/**
 * Audit settlement (ticket 14, hole 2): when audit close fails a Reserved
 * part to Unavailable, its active device_parts attachment is ended HERE —
 * the batchparts seam owns the device_parts table — with the truthful
 * removal record (removed_to 'unavailable', removal_reason 'audit') and a
 * `device.part_settled` event naming the audit. Without this, the part went
 * Unavailable while its attachment stayed active and the next swap failed
 * with a misleading race error.
 *
 * Runs inside the caller's (audit close) transaction. A Reserved part with
 * no active attachment has nothing to settle — the guarded status flip
 * still applies (tests may force Reserved state directly).
 */
export function settleAttachmentForAuditFailure(
  db: Database.Database,
  clock: Clock,
  actorId: number,
  params: {
    partId: number;
    serial: string;
    sku: string;
    auditId: number;
    note: string;
  }
): void {
  const attachment = db
    .prepare(
      "SELECT id, device_id FROM device_parts WHERE part_id = ? AND removed_at IS NULL"
    )
    .get(params.partId) as { id: number; device_id: number } | undefined;
  if (!attachment) {
    return;
  }
  closeAttachment(db, attachment.id, {
    removedAt: clock.now().toISOString(),
    removedBy: actorId,
    removedTo: "unavailable",
    removalNote: params.note,
    removalReason: "audit",
  });
  recordEvent(db, clock, {
    entityType: "device",
    entityId: attachment.device_id,
    actorId,
    action: "device.part_settled",
    payload: {
      attachmentId: attachment.id,
      serial: params.serial,
      sku: params.sku,
      auditId: params.auditId,
      reason: "audit_failed",
      note: params.note,
    },
  });
}
