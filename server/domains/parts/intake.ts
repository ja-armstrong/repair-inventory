import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";
import { applyCount, type CountablePartRow } from "../audits/counting.js";
import { autoReserveOntoDemandDevice } from "../batchparts/autoreserve.js";
import { getSkuRow, listOutstandingDemand } from "../batchparts/queries.js";
import { autoUnblockAfterDemandFulfilled } from "../batches/lifecycle.js";
import { formatSerial, nextPartId } from "./serials.js";
import { resolveEffectivePriceCents } from "./effective-price.js";
import type { CurrentUser } from "../auth/session.js";

/**
 * The intake module (ticket 13): the ONE writer of non-PO serialized-parts
 * rows — migration intake (bulk shelf stock) and salvage intake (a single
 * part with its provenance). PO receiving is the other intake door
 * (purchaseorders/receiving.ts) and stamps the same column; these two are
 * the only places a serialized_parts row is born.
 *
 * Vocabulary per CONTEXT.md, **Intake Source**: purchase order, migration,
 * or salvage. The source lives on the part row (`serialized_parts.intake_source`)
 * because the reports split by it — the expense total counts purchase-order
 * receipts, and consumed migration/salvage parts are listed separately —
 * a plain typed column, queryable per part and GROUP BY-able in SQL.
 *
 * Rules, each with its WHY:
 * - Salvage is exactly one part with a required provenance note: the story
 *   (what it came off, why it exists) is the point of salvage intake — a
 *   salvage without it is an untracked mystery part. Bulk additions are
 *   migration intake, so a salvage quantity > 1 is a caller error.
 * - Migration marks parts counted ONLY when the tech confirms a physical
 *   count, and the refresh goes through the shared counting seam
 *   (audits/counting.ts `applyCount`) — the same mechanism a cycle count
 *   uses, so audit due-ness treats it as a real count, not a special case.
 *   Unconfirmed parts keep last_counted_at NULL: the first audit demands
 *   them, which keeps audits honest about the back room (spec story 77).
 * - `purchase-order` is not accepted here: a part enters through a PO only
 *   by being received against it.
 * - An optional per-part price (ticket 23, CONTEXT.md: Part Price) is
 *   stamped at birth: the override column starts life as the tech entered
 *   it, or NULL to follow the SKU price.
 * - An intake is an intake (ticket 10, spec decision 9): an arriving unit
 *   whose SKU has outstanding Need to Order demand auto-reserves FIFO to
 *   the OLDEST outstanding demand, attaching onto `demand.device_id`
 *   through batchparts' ONE auto-reserve seam (`autoReserveOntoDemandDevice`)
 *   — the same hardened path a PO receipt takes, so the lifecycle check and
 *   the approval amend exist in exactly one place. "Outstanding" is
 *   batchparts' one definition (`listOutstandingDemand`: open + batch Open +
 *   not already on a PO) — intake never re-derives it, so the demand queue
 *   and its consumers can never disagree. The seam attaches but never picks
 *   or fulfills: picking (oldest first, the queue's own order) and the
 *   open → fulfilled flip stay here, with the same guarded
 *   `WHERE status = 'open'` semantics the receipt uses — and the flip
 *   carries fulfillment's status consequence
 *   (`batches/lifecycle.js autoUnblockAfterDemandFulfilled`: a Parts-needed
 *   device whose LAST open need filled returns to Awaiting repair). A demand
 *   with no device is fulfilled from stock with no attachment (the unit
 *   stays Available) — exactly how a receipt treats it. A seam refusal (the
 *   lifecycle gate, e.g. a Closed batch) leaves the part Available and is
 *   surfaced loudly in the intake result — never swallowed. No outstanding
 *   demand → the part lands Available as before.
 */

/** The intake-source vocabulary (CONTEXT.md). One definition, shared with PO receiving. */
export const INTAKE_SOURCES = ["purchase-order", "migration", "salvage"] as const;

export type IntakeSource = (typeof INTAKE_SOURCES)[number];

export type IntakeInputSource = Exclude<IntakeSource, "purchase-order">;

/**
 * One created part plus where its arrival landed it (ticket 10). The flat
 * vocabulary mirrors the PO receipt's `ReceiveResult` (`reserved`,
 * `reservationRefusal`, `demandId`, batch/device ids) so both intake doors
 * report an arrival the same way; `deviceLabel` is presentation, added by
 * the route through batchparts' shared label helper.
 */
export interface IntakePartResult {
  id: number;
  serial: string;
  /** True when the part auto-reserved onto a demanding device. */
  reserved: boolean;
  /** The demand this part fulfilled — reserved onto its device, or fulfilled from stock when it had no device. */
  demandId: number | null;
  batchId: number | null;
  batchNumber: number | null;
  deviceId: number | null;
  /**
   * A refusal from the auto-reserve seam (the lifecycle gate, e.g. a Closed
   * batch): the part stays Available, the demand stays open, and the refusal
   * is surfaced — never swallowed.
   */
  reservationRefusal: string | null;
}

export interface IntakeParams {
  skuId: number;
  source: IntakeInputSource;
  quantity: number;
  /**
   * The note that lands on the part's timeline: salvage's REQUIRED
   * provenance (what it came off, why it exists) or migration's optional
   * free-text remark. Required for salvage, optional otherwise.
   */
  note?: string;
  /** Migration only: did the tech physically count these parts right now? */
  counted?: boolean;
  /**
   * The part's own price override in cents (ticket 23, CONTEXT.md: Part
   * Price) — the eBay case: bought at a price that is not the catalog
   * price. Optional; omitted (NULL) means "use the SKU's current price".
   * Every part in the intake gets the same price (one intake, one price).
   */
  priceCents?: number;
}

/**
 * The invariant behind the nullable schema column (migration 0013): the
 * write seams always set intake_source, so a NULL would mean someone
 * inserted a part outside this module and PO receiving — a loud data defect,
 * surfaced here rather than guessed around.
 */
export function countPartsByIntakeSource(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT intake_source, COUNT(*) AS n
         FROM serialized_parts
        WHERE intake_source IS NOT NULL
     GROUP BY intake_source`
    )
    .all() as Array<{ intake_source: string; n: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.intake_source] = row.n;
  }
  return counts;
}

function countableRow(db: Database.Database, partId: number): CountablePartRow {
  const row = db
    .prepare(
      `SELECT p.id, p.serial, p.status, p.last_counted_at, p.created_at, p.sku_id, s.name AS sku_name
         FROM serialized_parts p JOIN skus s ON s.id = p.sku_id
        WHERE p.id = ?`
    )
    .get(partId) as CountablePartRow | undefined;
  if (!row) {
    throw new Error(`part ${partId} vanished inside its own intake transaction`);
  }
  return row;
}

/**
 * The demand's one status flip — the same guarded `WHERE status = 'open'`
 * UPDATE a PO receipt runs (purchaseorders/receiving.ts). A miss means the
 * picked demand changed under us: loud throw, never a silent skip.
 */
function fulfillDemand(
  db: Database.Database,
  clock: Clock,
  actorId: number,
  now: string,
  demand: { id: number; batch_id: number; device_id: number | null },
  part: { partId: number; serial: string },
  skuId: number,
  skuName: string,
  source: IntakeInputSource
): void {
  const fulfilled = db
    .prepare(
      `UPDATE demand_records
          SET status = 'fulfilled', fulfilled_at = ?, fulfilled_by = ?
        WHERE id = ? AND status = 'open'`
    )
    .run(now, actorId, demand.id);
  if (fulfilled.changes !== 1) {
    throw new Error(`demand ${demand.id} was picked for intake but is no longer open`);
  }
  recordEvent(db, clock, {
    entityType: "demand",
    entityId: demand.id,
    actorId,
    action: "demand.fulfilled",
    payload: {
      skuId,
      sku: skuName,
      batchId: demand.batch_id,
      deviceId: demand.device_id,
      partId: part.partId,
      serial: part.serial,
      // The cause pointer, as the receipt's payload carries the PO: which
      // intake door satisfied the need.
      intakeSource: source,
    },
  });
}

/**
 * One part's arrival at the demand queue (ticket 10): pick the OLDEST
 * outstanding demand for the SKU (the queue's own order — creation order),
 * attach through the seam when the demand names a device, and fulfill the
 * demand. Freshly fulfilled demands vanish from the outstanding definition,
 * so each part in one intake consumes the next demand in line — one
 * serialized part per demand unit.
 */
function arriveAtDemand(
  db: Database.Database,
  clock: Clock,
  actor: CurrentUser,
  now: string,
  params: {
    partId: number;
    serial: string;
    skuId: number;
    skuName: string;
    /** The part's OWN effective price — what the attachment and the approval amend price at. */
    priceCents: number;
    source: IntakeInputSource;
  }
): IntakePartResult {
  const base: IntakePartResult = {
    id: params.partId,
    serial: params.serial,
    reserved: false,
    demandId: null,
    batchId: null,
    batchNumber: null,
    deviceId: null,
    reservationRefusal: null,
  };
  const demand = listOutstandingDemand(db).find((row) => row.sku_id === params.skuId);
  if (!demand) {
    // No outstanding demand: the part lands Available as today.
    return base;
  }
  const landed: IntakePartResult = {
    ...base,
    demandId: demand.id,
    batchId: demand.batch_id,
    batchNumber: demand.batch_number,
    deviceId: demand.device_id,
  };
  if (demand.device_id === null) {
    // A demand with no device cannot take an attachment; fulfilling it from
    // stock is exactly what a PO receipt does — the unit stays Available.
    fulfillDemand(db, clock, actor.id, now, demand, params, params.skuId, params.skuName, params.source);
    return landed;
  }
  const reservation = autoReserveOntoDemandDevice(db, clock, {
    batchId: demand.batch_id,
    deviceId: demand.device_id,
    partId: params.partId,
    serial: params.serial,
    skuId: params.skuId,
    sku: params.skuName,
    priceCents: params.priceCents,
    demandId: demand.id,
    addedAt: now,
    addedBy: actor.id,
    source: params.source,
    cause: `auto-reserved on ${params.source} intake (serial ${params.serial})`,
  });
  if (!reservation.ok) {
    // Loud, not silent: the part stays Available, the demand stays open for
    // manual resolution, and the refusal travels in the intake result.
    return { ...landed, reservationRefusal: reservation.message };
  }
  fulfillDemand(db, clock, actor.id, now, demand, params, params.skuId, params.skuName, params.source);
  // Fulfillment's status consequence (one rule, one home): the demanding
  // device leaves "Parts needed" for "Awaiting repair" when this was its
  // last open need — the same move a PO receipt makes.
  autoUnblockAfterDemandFulfilled(db, clock, actor, demand.device_id);
  return { ...landed, reserved: true };
}

/**
 * One intake action: `quantity` serialized parts of one SKU, in one
 * transaction, each with its part.added event (source + provenance) and —
 * when confirmed — its part.counted event through the shared counting seam.
 * Each part then arrives at the outstanding-demand queue (ticket 10).
 * Returns the created parts with their reservation outcome.
 * Transaction-composable; callers run it inside their request transaction.
 *
 * Param-shape violations (salvage without provenance, salvage with a bulk
 * quantity, migration without an explicit counted flag, purchase-order as a
 * source) THROW — the HTTP edge validates them with the intake schema, so
 * reaching this function with a bad shape is a caller bug, not a request
 * variant.
 */
export function intakeParts(
  db: Database.Database,
  clock: Clock,
  actor: CurrentUser,
  params: IntakeParams
): IntakePartResult[] {
  const { source, skuId } = params;
  if (source === "salvage") {
    // Provenance is the salvage contract (CONTEXT.md: Intake Source; spec story 75).
    if (params.note === undefined || params.note.trim() === "") {
      throw new Error("salvage intake requires a provenance note — route validation failed");
    }
    if (params.quantity !== 1) {
      throw new Error(`salvage intake adds exactly one part, got quantity ${params.quantity}`);
    }
  }
  if (source === "migration" && typeof params.counted !== "boolean") {
    throw new Error("migration intake requires an explicit counted confirmation — route validation failed");
  }

  const now = clock.now().toISOString();
  const insert = db.prepare(
    `INSERT INTO serialized_parts (id, sku_id, serial, status, last_counted_at, created_at, intake_source, price_cents)
     VALUES (?, ?, ?, 'available', NULL, ?, ?, ?)`
  );
  const run = db.transaction((): IntakePartResult[] => {
    const created: Array<{ id: number; serial: string }> = [];
    for (let i = 0; i < params.quantity; i += 1) {
      const partId = nextPartId(db);
      const serial = formatSerial(partId);
      insert.run(partId, skuId, serial, now, source, params.priceCents ?? null);
      recordEvent(db, clock, {
        entityType: "part",
        entityId: partId,
        actorId: actor.id,
        action: "part.added",
        payload: {
          serial,
          source,
          // The provenance note (salvage, required) and any free-text note
          // (migration, optional) both land on the timeline — nothing the
          // tech typed is dropped.
          ...(params.note !== undefined ? { note: params.note.trim() } : {}),
          // The per-part price override (ticket 23) is recorded when given;
          // absent means "follows the SKU price".
          ...(params.priceCents !== undefined ? { priceCents: params.priceCents } : {}),
        },
      });
      created.push({ id: partId, serial });
    }
    // The counted confirmation is a real count, applied per part through the
    // one counting seam AFTER the rows exist (applyCount re-reads the part).
    if (source === "migration" && params.counted) {
      for (const part of created) {
        applyCount(db, clock, actor, countableRow(db, part.id), { kind: "migration_intake" }, null);
      }
    }
    // The arrival pass (ticket 10): the part's OWN price is the attachment's
    // snapshot and the value the approval amends to — the effective price
    // through the one resolver (override ?? SKU price), never a guess.
    const skuRow = getSkuRow(db, skuId);
    if (!skuRow) {
      throw new Error(`SKU ${skuId} vanished inside its own intake transaction`);
    }
    const effectivePriceCents = resolveEffectivePriceCents(params.priceCents ?? null, skuRow.price_cents);
    return created.map((part) =>
      arriveAtDemand(db, clock, actor, now, {
        partId: part.id,
        serial: part.serial,
        skuId,
        skuName: skuRow.name,
        priceCents: effectivePriceCents,
        source,
      })
    );
  });
  return run();
}
