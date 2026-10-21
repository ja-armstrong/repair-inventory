import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";
import { hasManagerPowers, type CurrentUser } from "../auth/session.js";
import { formatCents } from "../parts/prices.js";
import { normalizeSerial } from "../parts/serials.js";
import { resolveEffectivePriceCents, stampPartPriceOverride } from "../parts/effective-price.js";
import { partStatusLabel, reservePart } from "../parts/status.js";
import { TERMINAL_STATUSES, type RepairStatus } from "../batches/statuses.js";
import { amendApproval, setRepairStatus } from "../batches/lifecycle.js";
import {
  devicePostApprovalSpendCents,
  devicePriceAddLimitCents,
  getBatchDevice,
  getScannablePart,
  getSkuRow,
  insertAttachment,
  insertConsumableUsage,
  insertDemand,
  oldestAvailablePart,
  removeConsumableRow,
  type BatchDeviceRow,
  type PartSummaryRow,
  type ScannablePartRow,
  type SkuRow,
} from "./queries.js";

/**
 * THE one reservation core: attaching a serialized SKU (or a scanned serial)
 * to a device — pick (scan or oldest-Available) → guarded status flip →
 * attachment row → events, with the Need to Order fallback when SKU stock is
 * short, and the batch-lifecycle gates (terminal device, Price Add Limit,
 * amendment note) applied before anything is written.
 *
 * Every caller goes through here — the HTTP add endpoint, and the batches
 * domain's device creation with pre-attached SKUs — so there is exactly one
 * writer of the reservation rules and one event vocabulary, however a part
 * reaches a device. Failures are returned as { http, message } results (the
 * edges map them to responses); a throw is a programming error, and races /
 * refusals raised INSIDE the transaction are converted below so the whole
 * write rolls back with nothing half-done.
 */

export interface AddOutcome {
  kind: "attachment" | "demand";
  id: number;
}

/** A request-level refusal, raised inside a transaction to roll it back. */
export class AttachRefusedError extends Error {
  constructor(
    message: string,
    readonly http: number
  ) {
    super(message);
  }
}

export interface AttachFailure {
  ok: false;
  http: number;
  message: string;
}

export type AttachResult = { ok: true; outcome: AddOutcome } | AttachFailure;

/** Terminal devices refuse part changes; the message names the rule. */
export function terminalDeviceRefusal(device: BatchDeviceRow): AttachFailure | null {
  if (!TERMINAL_STATUSES.has(device.repair_status as RepairStatus)) {
    return null;
  }
  const hint =
    device.repair_status === "Repaired"
      ? " If it was set by accident, move the device back to In progress or QA first."
      : "";
  return {
    ok: false,
    http: 409,
    message: `${device.repair_status} is terminal on this batch — the device's parts can no longer be changed.${hint}`,
  };
}

/** A human label for a gated device: model plus its best identifier. */
export function deviceLabel(db: Database.Database, deviceId: number): string {
  const row = db
    .prepare(
      `SELECT d.id, d.imei, d.asset_id, d.serial_number, m.name AS model_name
         FROM devices d JOIN device_models m ON m.id = d.model_id
        WHERE d.id = ?`
    )
    .get(deviceId) as
    | { id: number; imei: string | null; asset_id: string | null; serial_number: string | null; model_name: string }
    | undefined;
  if (!row) {
    return `#${deviceId}`;
  }
  const identifier =
    row.imei ??
    (row.asset_id ? `Asset ${row.asset_id}` : null) ??
    (row.serial_number ? `SN ${row.serial_number}` : null);
  return `${row.model_name}${identifier ? ` (${identifier})` : ` (#${row.id})`}`;
}

/**
 * The Price Add Limit gate (ticket 28, CONTEXT.md: Approval). On an OPEN
 * batch, a tech's addition — a reserved part's snapshot cost, or consumable
 * quantity × unit price — may not push the device's DERIVED post-approval
 * spend past the device's limit. Equal to the limit is allowed ("up to"). A
 * manager is never gated: the manager IS the override, adding in place via
 * the amendment flow. Returns the refusal, or null when the addition may
 * proceed.
 */
export function priceAddLimitRefusal(
  db: Database.Database,
  device: BatchDeviceRow,
  actor: CurrentUser,
  additionCents: number,
  what: string
): AttachFailure | null {
  if (hasManagerPowers(actor.role) || device.batch_status !== "Open") {
    return null;
  }
  // The shared DERIVED spend (queries.ts) — never a parallel computation.
  const limit = devicePriceAddLimitCents(db, device.id);
  const spend = devicePostApprovalSpendCents(db, device.id);
  if (spend + additionCents <= limit) {
    return null;
  }
  return {
    ok: false,
    http: 409,
    message:
      `adding ${what} would cost ${formatCents(additionCents)} — device ${deviceLabel(db, device.id)} has added ` +
      `${formatCents(spend)} of its ${formatCents(limit)} price add limit since approval, and this would exceed it. ` +
      `Options: a manager can add it in place (amending the approval), the device can be set to ` +
      `Additional issues present (retriage onto a new batch with a fresh limit), or it can be set to Unrepairable.`,
  };
}

/**
 * A manager's post-approval part change amends the standing approval in the
 * same transaction. Ticket 28: a TECH's in-limit addition is pre-authorized
 * by the device's Price Add Limit — it does not amend the approval (the
 * manager override, which the gate's refusal message offers, does).
 * Tickets 30 + 02: a tech's removal DOES amend (the `always` flag) — the
 * cost genuinely moved and no pre-authorization covers taking value away;
 * a removal only ever reduces cost, so it is not manager-gated, and the
 * note records why. Approved cost must never go stale on a removal.
 */
export function amendIfApproved(
  db: Database.Database,
  clock: Clock,
  actor: CurrentUser,
  device: BatchDeviceRow,
  note: string,
  always = false
): void {
  if (device.batch_status === "Open" && (always || hasManagerPowers(actor.role))) {
    amendApproval(db, clock, actor, device.batch_id, note);
  }
}

export interface AttachSkuParams {
  batchId: number;
  deviceId: number;
  /** Exactly one of skuId / scannedSerial — the scan names unit AND SKU. */
  skuId?: number;
  scannedSerial?: string;
  /** The Need to Order record's optional supplier link (SKU path only). */
  supplier?: string;
  note?: string;
  /** The part's own price override (ticket 23); undefined = not provided. */
  priceCentsOverride?: number;
}

/**
 * Attach one serialized SKU — or the exact unit a scanned serial names — to
 * a device. All rules enforced here, in the same order the HTTP add
 * endpoint has always applied them.
 */
export function attachSkuToDevice(
  db: Database.Database,
  clock: Clock,
  actor: CurrentUser,
  params: AttachSkuParams
): AttachResult {
  const device = getBatchDevice(db, params.batchId, params.deviceId);
  if (!device) {
    return { ok: false, http: 404, message: "no device with that id on this batch" };
  }
  const terminal = terminalDeviceRefusal(device);
  if (terminal) {
    return terminal;
  }

  // The scanned unit (scan-to-add): the serial names BOTH the exact unit
  // and its SKU. Unknown serial → 404; a unit that is not Available → 409 —
  // a scan is a physical fact, so unlike the SKU path it NEVER falls back
  // to a Need to Order record.
  const scannedPart =
    params.scannedSerial === undefined
      ? undefined
      : getScannablePart(db, normalizeSerial(params.scannedSerial));
  if (params.scannedSerial !== undefined && !scannedPart) {
    return {
      ok: false,
      http: 404,
      message: `no serialized part with serial ${normalizeSerial(params.scannedSerial)}`,
    };
  }
  if (scannedPart && scannedPart.status !== "available") {
    return {
      ok: false,
      http: 409,
      message: `serial ${scannedPart.serial} is ${partStatusLabel(scannedPart.status)}, not Available — only an Available unit can be added to a device`,
    };
  }

  const skuId = scannedPart?.sku_id ?? params.skuId;
  if (skuId === undefined) {
    return {
      ok: false,
      http: 400,
      message: "a SKU or a scanned serial is required — pick the part kind, or scan the unit's serial to add that exact unit",
    };
  }
  const sku = getSkuRow(db, skuId);
  if (!sku) {
    return { ok: false, http: 404, message: "no SKU with that id" };
  }
  if (sku.kind !== "serialized") {
    return {
      ok: false,
      http: 400,
      message: `${sku.name} is a consumable SKU — consumables are recorded as usage on the device, not reserved as serialized units`,
    };
  }

  const priceProvided = params.priceCentsOverride !== undefined;
  const note = params.note;
  // The Price Add Limit gate (ticket 28) runs BEFORE the note check: the
  // prospective addition is the snapshot the reservation would take — the
  // tech's supplied override, the scanned unit's effective price, or the
  // oldest Available unit's effective price. The Need to Order path adds no
  // cost (no unit is reserved), so it is not gated.
  let additionCents: number | undefined;
  if (priceProvided) {
    additionCents = params.priceCentsOverride;
  } else if (scannedPart) {
    additionCents = resolveEffectivePriceCents(scannedPart.price_cents, scannedPart.sku_price_cents);
  } else {
    const prospectiveUnit = oldestAvailablePart(db, sku.id);
    if (prospectiveUnit) {
      additionCents = resolveEffectivePriceCents(prospectiveUnit.price_cents, sku.price_cents);
    }
  }
  if (additionCents !== undefined) {
    const refusal = priceAddLimitRefusal(db, device, actor, additionCents, `a part of ${sku.name}`);
    if (refusal) {
      return refusal;
    }
  }

  const batchId = params.batchId;
  const deviceId = params.deviceId;
  const batchNumber = device.batch_number;

  // The reservation transaction: pick → guarded status flip → attachment
  // row → events. The pick is the scanned unit when one was given, else the
  // oldest Available unit of the SKU. If Available stock is short on the
  // SKU path, the same transaction writes the Need to Order demand record
  // instead — never on the scan path (a scanned serial that cannot be
  // reserved is a loud refusal, not a guess about what is needed). A
  // manager's post-approval add amends the standing approval in the same
  // transaction.
  const run = db.transaction((): AddOutcome => {
    const unit: ScannablePartRow | PartSummaryRow | undefined = scannedPart
      ? getScannablePart(db, scannedPart.serial)
      : oldestAvailablePart(db, sku.id);
    if (!unit) {
      if (scannedPart) {
        throw new AttachRefusedError(`no serialized part with serial ${scannedPart.serial}`, 404);
      }
      if (priceProvided) {
        // The price describes a physical unit; there is none. Loud refusal
        // (nothing written, demand not created) — never apply a price to an
        // add that reserved nothing.
        throw new AttachRefusedError(
          "a price can only be set on a reserved unit and no stock was Available — nothing was changed; add the part again without a price to file the Need to Order record",
          400
        );
      }
      const demandId = insertDemand(db, {
        skuId: sku.id,
        batchId,
        deviceId,
        supplier: params.supplier ?? null,
        createdAt: clock.now().toISOString(),
        createdBy: actor.id,
      });
      recordEvent(db, clock, {
        entityType: "demand",
        entityId: demandId,
        actorId: actor.id,
        action: "demand.created",
        payload: {
          skuId: sku.id,
          sku: sku.name,
          batchId,
          batchNumber,
          deviceId,
          supplier: params.supplier ?? null,
        },
      });
      recordEvent(db, clock, {
        entityType: "device",
        entityId: deviceId,
        actorId: actor.id,
        action: "device.demand_created",
        payload: {
          demandId,
          skuId: sku.id,
          sku: sku.name,
          supplier: params.supplier ?? null,
          ...(note ? { note } : {}),
        },
      });
      // The device sits in "Parts needed" until the demand is fulfilled.
      // Every active status can reach it (statuses.ts graph), and terminal
      // devices were refused above. Fulfillment (a PO receipt or an intake
      // arrival) auto-returns the device to "Awaiting repair" when the
      // fulfilled demand was its last open need (batches/lifecycle.ts);
      // leaving Parts needed any other way is a human call via the status
      // endpoint.
      if (device.repair_status !== "Parts needed") {
        // Through the batches domain's guarded status change (architecture
        // finding D): graph-checked and event-recorded in one place. The
        // graph guarantees a non-terminal device reaches "Parts needed", so
        // a refusal here means the graph regressed — fail loud.
        const moved = setRepairStatus(db, clock, actor, {
          deviceId,
          to: "Parts needed",
          reason: "need to order",
        });
        if (!moved.ok) {
          throw new Error(`auto-move to Parts needed was refused by the status graph: ${moved.message}`);
        }
      }
      amendIfApproved(db, clock, actor, device, note ?? "");
      return { kind: "demand", id: demandId };
    }
    if (!reservePart(db, unit.id)) {
      // A scanned unit that lost the race out of Available is a scan
      // refusal (say so about the serial), not a generic race — the tech
      // must know THAT unit is gone.
      throw scannedPart
        ? new AttachRefusedError(
            `serial ${unit.serial} is no longer Available — nothing was changed`,
            409
          )
        : new AttachRefusedError(
            "that Available unit was claimed by another request mid-write — nothing was changed; try again",
            409
          );
    }
    // Ticket 23: the snapshot is the unit's EFFECTIVE price — the
    // tech-supplied override when given, else the unit's own override (e.g.
    // stamped at intake or PO receipt), else the SKU price. The explicit
    // override is stamped on the unit in the same transaction.
    const overrideCents = priceProvided ? (params.priceCentsOverride as number) : unit.price_cents;
    const snapshotCents = resolveEffectivePriceCents(overrideCents, sku.price_cents);
    if (priceProvided) {
      stampPartPriceOverride(db, unit.id, params.priceCentsOverride as number);
    }
    const attachmentId = insertAttachment(db, {
      deviceId,
      partId: unit.id,
      priceCents: snapshotCents,
      addedAt: clock.now().toISOString(),
      addedBy: actor.id,
    });
    recordEvent(db, clock, {
      entityType: "part",
      entityId: unit.id,
      actorId: actor.id,
      action: "part.reserved",
      payload: {
        serial: unit.serial,
        skuId: sku.id,
        sku: sku.name,
        batchId,
        batchNumber,
        deviceId,
        priceCents: snapshotCents,
        ...(overrideCents !== null ? { priceOverridden: true } : {}),
        ...(scannedPart ? { via: "serial_scan" } : {}),
        ...(note ? { note } : {}),
      },
    });
    recordEvent(db, clock, {
      entityType: "device",
      entityId: deviceId,
      actorId: actor.id,
      action: "device.part_reserved",
      payload: {
        attachmentId,
        serial: unit.serial,
        skuId: sku.id,
        sku: sku.name,
        priceCents: snapshotCents,
        ...(overrideCents !== null ? { priceOverridden: true } : {}),
        ...(scannedPart ? { via: "serial_scan" } : {}),
        ...(note ? { note } : {}),
      },
    });
    amendIfApproved(db, clock, actor, device, note ?? "");
    return { kind: "attachment", id: attachmentId };
  });

  try {
    const outcome = run();
    return { ok: true, outcome };
  } catch (error) {
    if (error instanceof AttachRefusedError) {
      return { ok: false, http: error.http, message: error.message };
    }
    throw error;
  }
}

export interface RecordConsumableParams {
  batchId: number;
  deviceId: number;
  skuId: number;
  quantity: number;
  note?: string;
}

export type RecordConsumableResult = { ok: true; usageId: number } | AttachFailure;

/**
 * THE one consumable-usage core: recording quantity × unit price of a
 * consumable SKU on a device. The consumable's COST is what is tracked —
 * the item has no units, no stock count, and nothing to reserve (CONTEXT.md:
 * Consumable) — but the device's Parts Cost carries it exactly like a
 * reserved part, gated by the same rules (terminal device, Price Add Limit,
 * amendment note, approval amendment). Used by the consumables endpoint AND
 * by device creation's pre-attach, so a consumable reaches a device's cost
 * through one door however it is recorded.
 */
export function recordConsumableUsage(
  db: Database.Database,
  clock: Clock,
  actor: CurrentUser,
  params: RecordConsumableParams
): RecordConsumableResult {
  const device = getBatchDevice(db, params.batchId, params.deviceId);
  if (!device) {
    return { ok: false, http: 404, message: "no device with that id on this batch" };
  }
  const terminal = terminalDeviceRefusal(device);
  if (terminal) {
    return terminal;
  }
  const sku = getSkuRow(db, params.skuId);
  if (!sku) {
    return { ok: false, http: 404, message: "no SKU with that id" };
  }
  if (sku.kind !== "consumable") {
    return {
      ok: false,
      http: 400,
      message: `${sku.name} is a serialized SKU — serialized units are reserved onto the device through the parts endpoint`,
    };
  }
  // The Price Add Limit gate (ticket 28): usage costs quantity × unit price
  // and counts against the device's post-approval spend the moment it is
  // recorded — same gate, same message, as a serialized addition.
  const limitRefusal = priceAddLimitRefusal(
    db,
    device,
    actor,
    params.quantity * sku.price_cents,
    `consumable usage (${params.quantity} × ${sku.name})`
  );
  if (limitRefusal) {
    return limitRefusal;
  }
  const note = params.note;
  const run = db.transaction((): number => {
    const usageId = insertConsumableUsage(db, {
      deviceId: params.deviceId,
      skuId: sku.id,
      quantity: params.quantity,
      unitPriceCents: sku.price_cents,
      recordedAt: clock.now().toISOString(),
      recordedBy: actor.id,
    });
    recordEvent(db, clock, {
      entityType: "device",
      entityId: params.deviceId,
      actorId: actor.id,
      action: "device.consumable_used",
      payload: {
        usageId,
        skuId: sku.id,
        sku: sku.name,
        quantity: params.quantity,
        unitPriceCents: sku.price_cents,
        ...(note ? { note } : {}),
      },
    });
    // Consumable usage moves Parts Cost, so post-approval it amends the
    // standing approval exactly like a serialized part change.
    amendIfApproved(db, clock, actor, device, note ?? "");
    return usageId;
  });
  return { ok: true, usageId: run() };
}

/**
 * The post-approval REMOVAL gate, shared by part removal and consumable
 * usage removal (tickets 30 + 02, non-HTTP so the cores can use it): a
 * removal is a TECH decision — recovery of a part is never automatic and
 * never manager-gated, because a removal only ever reduces cost. On any
 * live batch (Awaiting approval or Open) ANY device qualifies, post-approval
 * and terminal-but-not-absorbing included (Repaired / Unrepairable /
 * Additional issues present); only a CLOSED batch refuses — its record is
 * finished. The removal still amends the standing approval in place
 * (amendIfApproved's `always` shape) with its required note. Returns the
 * refusal, or null when the removal may proceed.
 */
export function techRemoveRefusal(device: BatchDeviceRow): AttachFailure | null {
  if (device.batch_status !== "Closed") {
    return null;
  }
  return {
    ok: false,
    http: 409,
    message:
      `batch #${device.batch_number} is Closed — its record is finished and its parts can no longer be changed`,
  };
}

export interface RemoveConsumableResult {
  ok: true;
  usageId: number;
  sku: string;
  quantity: number;
  costCents: number;
}

/**
 * THE one consumable-usage removal core: a cost correction, soft-removed on
 * its row (migration 0021) and evented — never a silent delete. The note is
 * required (it records why the cost moved); the removal gates are the same
 * as part removal's (tickets 30 + 02: the techRemoveRefusal gate — any
 * device on a live batch, post-approval and terminal included; refused only
 * on a Closed batch). The row is kept, so Parts Cost and the expense report
 * drop via the active-only sums while every past record stays auditable.
 */
export function removeConsumableUsage(
  db: Database.Database,
  clock: Clock,
  actor: CurrentUser,
  params: {
    batchId: number;
    deviceId: number;
    usageId: number;
    note: string;
  }
): RemoveConsumableResult | AttachFailure {
  const note = params.note.trim();
  if (note === "") {
    return {
      ok: false,
      http: 400,
      message: "a note is required to remove consumable usage — it records why the cost moved",
    };
  }
  const device = getBatchDevice(db, params.batchId, params.deviceId);
  if (!device) {
    return { ok: false, http: 404, message: "no device with that id on this batch" };
  }
  const techGate = techRemoveRefusal(device);
  if (techGate) {
    return techGate;
  }
  const usage = db
    .prepare(
      `SELECT c.id, c.sku_id, c.quantity, c.unit_price_cents, c.removed_at, s.name AS sku_name
         FROM device_consumables c JOIN skus s ON s.id = c.sku_id
        WHERE c.id = ? AND c.device_id = ?`
    )
    .get(params.usageId, params.deviceId) as
    | { id: number; sku_id: number; quantity: number; unit_price_cents: number; removed_at: string | null; sku_name: string }
    | undefined;
  if (!usage) {
    return { ok: false, http: 404, message: "no consumable usage with that id on this device" };
  }
  if (usage.removed_at !== null) {
    return { ok: false, http: 409, message: "that consumable usage was already removed" };
  }
  const costCents = usage.quantity * usage.unit_price_cents;
  const run = db.transaction((): void => {
    if (
      !removeConsumableRow(db, usage.id, {
        removedAt: clock.now().toISOString(),
        removedBy: actor.id,
        removalNote: note,
      })
    ) {
      throw new AttachRefusedError(
        "that usage changed under this request — nothing was removed; reload and try again",
        409
      );
    }
    recordEvent(db, clock, {
      entityType: "device",
      entityId: params.deviceId,
      actorId: actor.id,
      action: "device.consumable_removed",
      payload: {
        usageId: usage.id,
        skuId: usage.sku_id,
        sku: usage.sku_name,
        quantity: usage.quantity,
        unitPriceCents: usage.unit_price_cents,
        costCents,
        note,
      },
    });
    // The cost genuinely moved: on an Open batch the standing approval is
    // amended with the note — the `always` shape, like a part removal.
    amendIfApproved(db, clock, actor, device, note, true);
  });
  try {
    run();
  } catch (error) {
    if (error instanceof AttachRefusedError) {
      return { ok: false, http: error.http, message: error.message };
    }
    throw error;
  }
  return {
    ok: true,
    usageId: usage.id,
    sku: usage.sku_name,
    quantity: usage.quantity,
    costCents,
  };
}
