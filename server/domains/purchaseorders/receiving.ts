import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";
import { autoReserveOntoDemandDevice } from "../batchparts/autoreserve.js";
import { autoUnblockAfterDemandFulfilled } from "../batches/lifecycle.js";
import { reservePart } from "../parts/status.js";
import { claimSerialIds, normalizeSerial, releaseSerialClaim } from "../parts/serials.js";
import { type IntakeSource } from "../parts/intake.js";
import type { PoRow, PoStatus } from "./serialize.js";

/**
 * Ticket 08 — labels and scan-to-receive.
 *
 * Expected serials are claimed (parts/serials.ts) per serialized PO line
 * when the PO leaves Awaiting approval, so label sheets can print before
 * anything arrives. Scanning creates the serialized_parts row as Available,
 * bumps the line's received quantity, refreshes the SKU price to the line's
 * unit cost, auto-reserves into the oldest open Need to Order demand for
 * that SKU (fulfilling it — which auto-returns a Parts-needed device to
 * Awaiting repair when the fulfilled demand was its last open need), and
 * recomputes Partially received vs Received.
 *
 * Cross-domain writes into demand_records / serialized_parts are the receipt
 * contract anticipated by migrations 0005 and 0006. The auto-reserve itself
 * goes through batchparts' ONE auto-reserve seam
 * (`autoReserveOntoDemandDevice`): batch-lifecycle check (a Closed batch
 * refuses — the receipt still completes and the demand stays open for
 * manual resolution), no Price Add Limit gate (the demand is the
 * approval-time intent; the arrival makes it real), and the approval
 * amended in place to the part's actual price with the receipt recorded as
 * the cause (ticket 09).
 */

export interface ExpectedSerialRow {
  id: number;
  line_id: number;
  serial: string;
  part_id: number | null;
  received_at: string | null;
  received_by: number | null;
  sku_id: number;
  sku_name: string;
  sku_kind: string;
  unit_price_cents: number;
  po_id: number;
  line_quantity: number;
  line_received_quantity: number;
  demand_id: number | null;
}

interface LineSkuRow {
  id: number;
  sku_id: number;
  quantity: number;
  received_quantity: number;
  unit_price_cents: number;
  demand_id: number | null;
  kind: string;
  name: string;
}

/** Idempotent: assign any missing expected serials for serialized lines. */
export function ensureExpectedSerials(
  db: Database.Database,
  poId: number,
  claimedAt: string
): number {
  const lines = db
    .prepare(
      `SELECT l.id, l.quantity, l.received_quantity, s.kind
         FROM purchase_order_lines l JOIN skus s ON s.id = l.sku_id
        WHERE l.po_id = ?`
    )
    .all(poId) as Array<{
    id: number;
    quantity: number;
    received_quantity: number;
    kind: string;
  }>;

  let assigned = 0;
  const insertExpected = db.prepare(
    "INSERT INTO purchase_order_expected_serials (id, line_id, serial) VALUES (?, ?, ?)"
  );
  for (const line of lines) {
    if (line.kind !== "serialized") {
      continue;
    }
    const existing = (
      db
        .prepare("SELECT COUNT(*) AS n FROM purchase_order_expected_serials WHERE line_id = ?")
        .get(line.id) as { n: number }
    ).n;
    const missing = line.quantity - existing;
    if (missing <= 0) {
      continue;
    }
    const claims = claimSerialIds(db, missing, claimedAt);
    for (const claim of claims) {
      insertExpected.run(claim.id, line.id, claim.serial);
      assigned += 1;
    }
  }
  return assigned;
}

export function listExpectedSerials(
  db: Database.Database,
  poId: number
): Array<{
  id: number;
  lineId: number;
  serial: string;
  received: boolean;
  partId: number | null;
  receivedAt: string | null;
  sku: { id: number; name: string; kind: string };
}> {
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

/**
 * Recompute status from line received quantities.
 * WHY: Partially received / Received are derived, never hand-set — shortfall
 * close is the only explicit status write after In-transit.
 */
export function computeReceivingStatus(db: Database.Database, poId: number): PoStatus {
  const lines = db
    .prepare(
      "SELECT quantity, received_quantity FROM purchase_order_lines WHERE po_id = ?"
    )
    .all(poId) as Array<{ quantity: number; received_quantity: number }>;
  if (lines.length === 0) {
    return "In-transit";
  }
  const anyReceived = lines.some((line) => line.received_quantity > 0);
  const allComplete = lines.every((line) => line.received_quantity >= line.quantity);
  if (allComplete) {
    return "Received";
  }
  if (anyReceived) {
    return "Partially received";
  }
  return "In-transit";
}

export function applyReceivingStatus(
  db: Database.Database,
  clock: Clock,
  po: PoRow,
  actorId: number
): PoStatus | null {
  if (po.status === "Closed" || po.status === "Awaiting approval") {
    return null;
  }
  const next = computeReceivingStatus(db, po.id);
  if (next === po.status) {
    return null;
  }
  db.prepare("UPDATE purchase_orders SET status = ? WHERE id = ?").run(next, po.id);
  recordEvent(db, clock, {
    entityType: "po",
    entityId: po.id,
    actorId,
    action: "po.status_changed",
    payload: {
      from: po.status,
      to: next,
      note: "computed from received quantities",
    },
  });
  return next;
}

export type ReceiveError =
  | { kind: "unknown_serial"; message: string }
  | { kind: "wrong_po"; message: string }
  | { kind: "already_received"; message: string }
  | { kind: "bad_status"; message: string };

export interface ReceiveResult {
  partId: number;
  serial: string;
  lineId: number;
  reserved: boolean;
  /** WHY the part was not auto-reserved (e.g. a Closed batch); null when reserved or no demand. */
  reservationRefusal: string | null;
  demandId: number | null;
  batchId: number | null;
  deviceId: number | null;
  priceChanged: boolean;
  status: PoStatus;
}

function getExpectedOnPo(
  db: Database.Database,
  poId: number,
  serial: string
): ExpectedSerialRow | undefined {
  return db
    .prepare(
      `SELECT e.id, e.line_id, e.serial, e.part_id, e.received_at, e.received_by,
              l.sku_id, l.quantity AS line_quantity, l.received_quantity AS line_received_quantity,
              l.unit_price_cents, l.demand_id, l.po_id, s.name AS sku_name, s.kind AS sku_kind
         FROM purchase_order_expected_serials e
         JOIN purchase_order_lines l ON l.id = e.line_id
         JOIN skus s ON s.id = l.sku_id
        WHERE e.serial = ?`
    )
    .get(serial) as ExpectedSerialRow | undefined;
}

/**
 * Which open Need to Order demand a received part fulfills, in priority
 * order. WHY: the purchase_order_demand link is the ordering contract — a
 * line created FROM a demand record must satisfy THAT demand first; any
 * other demand this PO marked ordered comes next; then the oldest open
 * demand for the SKU (ordering only hid demand from the create prompt, it
 * did not close it). One part fulfills one demand record.
 */
function pickDemand(
  db: Database.Database,
  poId: number,
  skuId: number,
  lineDemandId: number | null
): { id: number; batch_id: number; device_id: number | null } | undefined {
  const select = "SELECT id, batch_id, device_id FROM demand_records WHERE sku_id = ? AND status = 'open'";
  if (lineDemandId !== null) {
    const lineDemand = db
      .prepare(`${select} AND id = ?`)
      .get(skuId, lineDemandId) as { id: number; batch_id: number; device_id: number | null } | undefined;
    if (lineDemand) {
      return lineDemand;
    }
  }
  const linked = db
    .prepare(
      `${select} AND id IN (SELECT demand_id FROM purchase_order_demand WHERE po_id = ?)
        ORDER BY id LIMIT 1`
    )
    .get(skuId, poId) as { id: number; batch_id: number; device_id: number | null } | undefined;
  if (linked) {
    return linked;
  }
  return db.prepare(`${select} ORDER BY id LIMIT 1`).get(skuId) as
    | { id: number; batch_id: number; device_id: number | null }
    | undefined;
}

export function receiveSerial(
  db: Database.Database,
  clock: Clock,
  po: PoRow,
  actorId: number,
  rawSerial: string
): ReceiveResult | ReceiveError {
  // Serial-identity checks come BEFORE the status guard: when a scan is a
  // duplicate or a foreign label, that message tells the receiver more than
  // "the PO cannot receive right now".
  const serial = normalizeSerial(rawSerial);
  const expected = getExpectedOnPo(db, po.id, serial);
  if (expected && expected.po_id !== po.id) {
    return {
      kind: "wrong_po",
      message: `serial ${serial} belongs to a different purchase order`,
    };
  }
  if (expected && expected.part_id !== null) {
    return {
      kind: "already_received",
      message: `serial ${serial} was already received`,
    };
  }

  const receivable = ["In-transit", "Partially received"];
  if (!receivable.includes(po.status)) {
    return {
      kind: "bad_status",
      message: `only an In-transit or Partially received purchase order can receive parts — this one is ${po.status}`,
    };
  }

  if (!expected) {
    // Distinguish "never a label" from "label for a different PO".
    const anywhere = db
      .prepare("SELECT line_id FROM purchase_order_expected_serials WHERE serial = ?")
      .get(serial) as { line_id: number } | undefined;
    if (!anywhere) {
      return {
        kind: "unknown_serial",
        message: `unknown serial ${serial} — it is not an expected unit on any purchase order`,
      };
    }
    return {
      kind: "wrong_po",
      message: `serial ${serial} belongs to a different purchase order`,
    };
  }

  const now = clock.now().toISOString();
  const skuBefore = db
    .prepare("SELECT price_cents FROM skus WHERE id = ?")
    .get(expected.sku_id) as { price_cents: number };

  // Create the part as Available (the scan is the intake). Ticket 13: the
  // intake source is stamped here, from the shared vocabulary — PO receipt is
  // one of the three intake doors, and every part records which door it came
  // through (expense reporting counts purchase-order receipts). The
  // IntakeSource annotation makes the compile fail if the vocabulary renames.
  // Ticket 23 (CONTEXT.md: Part Price): the part's own price is stamped with
  // the received unit cost — the real cost of THAT unit is per-part price
  // data by definition, so the part is born with its override set and its
  // later attachments snapshot this price.
  const intakeSource: IntakeSource = "purchase-order";
  db.prepare(
    `INSERT INTO serialized_parts (id, sku_id, serial, status, last_counted_at, created_at, intake_source, price_cents)
     VALUES (?, ?, ?, 'available', NULL, ?, ?, ?)`
  ).run(expected.id, expected.sku_id, serial, now, intakeSource, expected.unit_price_cents);
  releaseSerialClaim(db, expected.id);

  recordEvent(db, clock, {
    entityType: "part",
    entityId: expected.id,
    actorId,
    action: "part.added",
    payload: {
      serial,
      source: "po_receive",
      intakeSource,
      poId: po.id,
      lineId: expected.line_id,
      priceCents: expected.unit_price_cents,
    },
  });

  db.prepare(
    `UPDATE purchase_order_expected_serials
        SET part_id = ?, received_at = ?, received_by = ?
      WHERE id = ?`
  ).run(expected.id, now, actorId, expected.id);

  db.prepare(
    "UPDATE purchase_order_lines SET received_quantity = received_quantity + 1 WHERE id = ?"
  ).run(expected.line_id);

  // Refresh catalog price to the received unit cost so prices track reality.
  // The refresh is recorded even when the amount is unchanged: the receipt
  // confirms the price, which resets staleness (price_updated_at), and every
  // field edit lands on the timeline — no silent writes.
  const priceChanged = skuBefore.price_cents !== expected.unit_price_cents;
  db.prepare("UPDATE skus SET price_cents = ?, price_updated_at = ? WHERE id = ?").run(
    expected.unit_price_cents,
    now,
    expected.sku_id
  );
  recordEvent(db, clock, {
    entityType: "sku",
    entityId: expected.sku_id,
    actorId,
    action: "sku.price_changed",
    payload: {
      from: skuBefore.price_cents,
      to: expected.unit_price_cents,
      reason: "po_receive",
      poId: po.id,
      serial,
    },
  });

  let reserved = false;
  let reservationRefusal: string | null = null;
  let demandId: number | null = null;
  let batchId: number | null = null;
  let deviceId: number | null = null;

  const demand = pickDemand(db, po.id, expected.sku_id, expected.demand_id);
  if (demand) {
    demandId = demand.id;
    batchId = demand.batch_id;
    deviceId = demand.device_id;
    // Auto-reserve BEFORE fulfilling: a Closed batch refuses the reservation,
    // and the demand must stay OPEN for manual resolution — fulfilling first
    // would erase the very need the refusal is reporting.
    if (demand.device_id !== null) {
      const reservation = autoReserveOntoDemandDevice(db, clock, {
        batchId: demand.batch_id,
        deviceId: demand.device_id,
        partId: expected.id,
        serial,
        skuId: expected.sku_id,
        sku: expected.sku_name,
        priceCents: expected.unit_price_cents,
        demandId: demand.id,
        addedAt: now,
        addedBy: actorId,
        source: "po_receive",
        cause: `auto-reserved on receipt of purchase order #${po.number} (serial ${serial})`,
      });
      if (reservation.ok) {
        reserved = true;
      } else {
        // Loud, not silent: the refusal lands in the response and on the
        // PO's timeline below; the demand stays open.
        reservationRefusal = reservation.message;
      }
    }
    // No device on the demand (or the reservation landed): fulfill it. The
    // guarded UPDATE is the demand's one status flip; a miss here means the
    // picked demand changed under us — loud, not a silent skip.
    if (reserved || demand.device_id === null) {
      const fulfilled = db
        .prepare(
          `UPDATE demand_records
              SET status = 'fulfilled', fulfilled_at = ?, fulfilled_by = ?
            WHERE id = ? AND status = 'open'`
        )
        .run(now, actorId, demand.id);
      if (fulfilled.changes !== 1) {
        throw new Error(`demand ${demand.id} was picked for receipt but is no longer open`);
      }
      recordEvent(db, clock, {
        entityType: "demand",
        entityId: demand.id,
        actorId,
        action: "demand.fulfilled",
        payload: {
          skuId: expected.sku_id,
          sku: expected.sku_name,
          batchId: demand.batch_id,
          deviceId: demand.device_id,
          partId: expected.id,
          serial,
          poId: po.id,
        },
      });
      // Fulfillment's status consequence (one rule, one home): the demanding
      // device leaves "Parts needed" for "Awaiting repair" when this was its
      // last open need. Reserved implies a device — a device-less demand has
      // nothing to move.
      if (reserved && demand.device_id !== null) {
        autoUnblockAfterDemandFulfilled(db, clock, { id: actorId }, demand.device_id);
      }
    }
  }

  recordEvent(db, clock, {
    entityType: "po",
    entityId: po.id,
    actorId,
    action: "po.part_received",
    payload: {
      serial,
      lineId: expected.line_id,
      skuId: expected.sku_id,
      sku: expected.sku_name,
      partId: expected.id,
      reserved,
      demandId,
      ...(reservationRefusal !== null ? { reservationRefusal } : {}),
    },
  });

  const status = applyReceivingStatus(db, clock, po, actorId) ?? computeReceivingStatus(db, po.id);

  return {
    partId: expected.id,
    serial,
    lineId: expected.line_id,
    reserved,
    reservationRefusal,
    demandId,
    batchId,
    deviceId,
    priceChanged,
    status,
  };
}

/** Receive quantity against a consumable line (no serials). */
export function receiveConsumableLine(
  db: Database.Database,
  clock: Clock,
  po: PoRow,
  actorId: number,
  lineId: number,
  quantity: number
): { lineId: number; receivedQuantity: number; status: PoStatus } | ReceiveError | { kind: "bad_line"; message: string } {
  const receivable = ["In-transit", "Partially received"];
  if (!receivable.includes(po.status)) {
    return {
      kind: "bad_status",
      message: `only an In-transit or Partially received purchase order can receive parts — this one is ${po.status}`,
    };
  }
  const line = db
    .prepare(
      `SELECT l.id, l.sku_id, l.quantity, l.received_quantity, l.unit_price_cents, l.demand_id,
              s.kind, s.name
         FROM purchase_order_lines l JOIN skus s ON s.id = l.sku_id
        WHERE l.id = ? AND l.po_id = ?`
    )
    .get(lineId, po.id) as LineSkuRow | undefined;
  if (!line) {
    return { kind: "bad_line", message: "no such line on this purchase order" };
  }
  if (line.kind !== "consumable") {
    return {
      kind: "bad_line",
      message: `${line.name} is a serialized SKU — receive it by scanning an expected serial`,
    };
  }
  const remaining = line.quantity - line.received_quantity;
  if (quantity < 1 || quantity > remaining) {
    return {
      kind: "bad_line",
      message: `quantity must be between 1 and ${remaining} (remaining on this line)`,
    };
  }
  const now = clock.now().toISOString();
  db.prepare(
    "UPDATE purchase_order_lines SET received_quantity = received_quantity + ? WHERE id = ?"
  ).run(quantity, lineId);

  const skuBefore = db
    .prepare("SELECT price_cents FROM skus WHERE id = ?")
    .get(line.sku_id) as { price_cents: number };
  // Same rule as serialized receipt: refresh and record even when the amount
  // is unchanged — the receipt confirms the price, nothing writes silently.
  db.prepare("UPDATE skus SET price_cents = ?, price_updated_at = ? WHERE id = ?").run(
    line.unit_price_cents,
    now,
    line.sku_id
  );
  recordEvent(db, clock, {
    entityType: "sku",
    entityId: line.sku_id,
    actorId,
    action: "sku.price_changed",
    payload: {
      from: skuBefore.price_cents,
      to: line.unit_price_cents,
      reason: "po_receive",
      poId: po.id,
    },
  });

  recordEvent(db, clock, {
    entityType: "po",
    entityId: po.id,
    actorId,
    action: "po.consumable_received",
    payload: { lineId, skuId: line.sku_id, sku: line.name, quantity },
  });

  const updated = (
    db.prepare("SELECT received_quantity FROM purchase_order_lines WHERE id = ?").get(lineId) as {
      received_quantity: number;
    }
  ).received_quantity;
  const status = applyReceivingStatus(db, clock, po, actorId) ?? computeReceivingStatus(db, po.id);
  return { lineId, receivedQuantity: updated, status };
}

export function closeWithShortfall(
  db: Database.Database,
  clock: Clock,
  po: PoRow,
  actorId: number,
  note: string
): { ok: true } | { kind: "bad_status"; message: string } | { kind: "no_shortfall"; message: string } {
  const closable = ["In-transit", "Partially received"];
  if (!closable.includes(po.status)) {
    return {
      kind: "bad_status",
      message: `only an In-transit or Partially received purchase order can be closed with a shortfall — this one is ${po.status}`,
    };
  }
  const status = computeReceivingStatus(db, po.id);
  if (status === "Received") {
    return {
      kind: "no_shortfall",
      message: "every line is fully received — there is no shortfall to close",
    };
  }
  const now = clock.now().toISOString();
  const lines = db
    .prepare(
      `SELECT l.id, l.quantity, l.received_quantity, s.name AS sku_name
         FROM purchase_order_lines l JOIN skus s ON s.id = l.sku_id
        WHERE l.po_id = ?`
    )
    .all(po.id) as Array<{
    id: number;
    quantity: number;
    received_quantity: number;
    sku_name: string;
  }>;
  const shortfall = lines
    .filter((line) => line.received_quantity < line.quantity)
    .map((line) => ({
      lineId: line.id,
      sku: line.sku_name,
      ordered: line.quantity,
      received: line.received_quantity,
      short: line.quantity - line.received_quantity,
    }));

  // A shortfall close RELEASES the demand records this PO marked ordered:
  // ordering only HID a demand from the outstanding queue (the shared
  // definition subtracts `purchase_order_demand` ids), and closing without
  // the goods would otherwise hide an unmet need forever. Deleting the
  // links returns every still-open record to both queues with NO
  // demand_records write — the link subtraction IS the mechanism.
  // Fulfilled/cancelled links are inert either way and are pruned with the
  // rest (the PO is terminal; nothing re-marks them).
  const demandReleased = (
    db
      .prepare(
        `SELECT l.demand_id FROM purchase_order_demand l
           JOIN demand_records d ON d.id = l.demand_id
          WHERE l.po_id = ? AND d.status = 'open'`
      )
      .all(po.id) as Array<{ demand_id: number }>
  ).map((row) => row.demand_id);
  db.prepare("DELETE FROM purchase_order_demand WHERE po_id = ?").run(po.id);

  db.prepare(
    `UPDATE purchase_orders
        SET status = 'Closed', closed_at = ?, closed_by = ?, closed_note = ?
      WHERE id = ?`
  ).run(now, actorId, note, po.id);

  recordEvent(db, clock, {
    entityType: "po",
    entityId: po.id,
    actorId,
    action: "po.status_changed",
    payload: {
      from: po.status,
      to: "Closed",
      note,
      shortfall,
      ...(demandReleased.length > 0 ? { demandReleased } : {}),
    },
  });
  return { ok: true };
}
