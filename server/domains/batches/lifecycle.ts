import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";
import { hasManagerPowers, type Role } from "../auth/session.js";
import {
  cancelDemandWithEvents,
  devicePartsCostCents,
  listActiveAttachmentsForDevice,
  listOpenDemandForDevice,
  moveAttachmentsToDevice,
  moveOpenDemandToDevice,
  returnAttachmentsToStock,
  settleBatchParts,
} from "../batchparts/queries.js";
import { TERMINAL_STATUSES, isPartsNeededUnblock, transitionError, type RepairStatus } from "./statuses.js";

/**
 * The batch lifecycle (ticket 06) — the ONE place batch state transitions
 * and device status changes live, so no other domain can bypass the graph
 * or the approval gate (architecture review finding D: batchparts used to
 * UPDATE devices.repair_status directly; it now calls setRepairStatus here).
 *
 * Rules enforced, each with its WHY:
 * - Approval is a manager's COST SIGN-OFF (spec story 35): the approval
 *   event records the approved Parts Cost total, computed from the
 *   snapshotted reservation prices, so the approved number cannot drift.
 * - Approval gates the repair PROCEEDING, not the stock reservation: before
 *   approval techs edit part lists freely, and a part shortage may park a
 *   device in "Parts needed" — but no other device transition is accepted.
 * - After approval a manager may still change parts in place; every such
 *   change may carry a note and AMENDS the approval (amendApproval
 *   recomputes and re-records the signed-off total). Techs are limited to
 *   same-SKU swaps — enforced in the batchparts endpoints, which call into
 *   this module for the amendment.
 * - "Additional issues present" ends the device's run on its batch: the
 *   status change and the retriage (new batch + carried device row + moved
 *   parts) happen in ONE transaction, so a device can never sit in that
 *   terminal status without its continuation existing.
 * - Close means done: every device must be terminal, and closing settles
 *   the parts (installed → Unavailable) through batchparts' guarded writes.
 */

export interface LifecycleFailure {
  ok: false;
  http: number;
  message: string;
}

export interface RetriageOutcome {
  batchId: number;
  batchNumber: number;
  deviceId: number;
}

export type StatusChangeResult =
  | { ok: true; retriage?: RetriageOutcome }
  | LifecycleFailure;

export type LifecycleResult<T> = { ok: true; value: T } | LifecycleFailure;

interface DeviceLifecycleRow {
  id: number;
  batch_id: number;
  batch_number: number;
  batch_status: string;
  repair_status: string;
}

interface ApprovalDeviceRow {
  id: number;
  repair_status: string;
  approval_decision: string | null;
  approval_decision_note: string | null;
  model_name: string;
  imei: string | null;
  asset_id: string | null;
  serial_number: string | null;
}

function getDeviceLifecycleRow(
  db: Database.Database,
  deviceId: number
): DeviceLifecycleRow | undefined {
  // Ticket 30: a removed device cannot take status changes — the row is
  // history, not live work.
  return db
    .prepare(
      `SELECT d.id, d.batch_id, d.repair_status, b.status AS batch_status, b.number AS batch_number
         FROM devices d JOIN batches b ON b.id = d.batch_id
        WHERE d.id = ? AND d.removed_at IS NULL`
    )
    .get(deviceId) as DeviceLifecycleRow | undefined;
}

/**
 * The guarded device status change — graph-checked, approval-gated,
 * event-recording, transaction-composable (callers may run inside their own
 * transaction; better-sqlite3 nests via savepoints). The batches status
 * endpoint AND batchparts' demand auto-move both go through this function;
 * there is no other writer of devices.repair_status.
 */
export function setRepairStatus(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  params: {
    deviceId: number;
    to: RepairStatus;
    resolutionNotes?: string;
    reason?: string;
  }
): StatusChangeResult {
  const row = getDeviceLifecycleRow(db, params.deviceId);
  if (!row) {
    return { ok: false, http: 404, message: "no device with that id" };
  }
  const from = row.repair_status as RepairStatus;
  if (from === params.to) {
    return { ok: true };
  }
  const graphProblem = transitionError(from, params.to);
  if (graphProblem) {
    return { ok: false, http: 409, message: graphProblem };
  }
  if (row.batch_status === "Closed") {
    return {
      ok: false,
      http: 409,
      message: "this batch is Closed — its devices can no longer change Repair Status",
    };
  }
  if (
    row.batch_status === "Awaiting approval" &&
    params.to !== "Parts needed" &&
    // The ticket-30 unblock is not repair work either — it records that the
    // device is no longer blocked (shared predicate with the client-facing
    // transition filter, statuses.ts).
    !isPartsNeededUnblock(from, params.to)
  ) {
    return {
      ok: false,
      http: 409,
      message:
        "this batch is Awaiting approval — a manager must approve it before repair proceeds (blocking on parts, and unblocking a cancelled need, are still allowed)",
    };
  }
  // Parts needed means BLOCKED: the unblock exit is refused while any open
  // Need to Order remains for the device — cancel or fulfil them first.
  if (from === "Parts needed" && params.to === "Awaiting repair") {
    const open = listOpenDemandForDevice(db, params.deviceId);
    if (open.length > 0) {
      return {
        ok: false,
        http: 409,
        message: `this device still has ${open.length} open Need to Order record${
          open.length === 1 ? "" : "s"
        } — cancel them (or receive their parts) before unblocking it`,
      };
    }
  }
  const resolutionNotes = params.resolutionNotes?.trim() ?? "";
  // Resolution notes are OPTIONAL: the status change itself is the record of
  // reaching the terminal status. When notes ARE given they become the
  // device's resolution notes; an omitted note simply records none.

  const run = db.transaction((): StatusChangeResult => {
    db.prepare(
      `UPDATE devices
          SET repair_status = ?,
              resolution_notes = CASE WHEN ? != '' THEN ? ELSE resolution_notes END,
              updated_at = ?
        WHERE id = ?`
    ).run(
      params.to,
      resolutionNotes,
      resolutionNotes,
      clock.now().toISOString(),
      params.deviceId
    );
    recordEvent(db, clock, {
      entityType: "device",
      entityId: params.deviceId,
      actorId: actor.id,
      action: "device.status_changed",
      payload: {
        from,
        to: params.to,
        ...(resolutionNotes !== "" ? { resolutionNotes } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
      },
    });
    // Retriage is PART of reaching "Additional issues present": the device's
    // run on this batch ends and its continuation is created in the same
    // transaction, so the terminal status never exists without it.
    if (params.to === "Additional issues present") {
      const retriage = retriageDevice(db, clock, actor, params.deviceId, resolutionNotes);
      return { ok: true, retriage };
    }
    return { ok: true };
  });
  return run();
}

/**
 * The automatic half of demand fulfillment: when a Need to Order demand
 * record is fulfilled (a PO receipt or a salvage/migration intake arrival),
 * its block on the demanding device is gone — so a device parked in
 * "Parts needed" returns to "Awaiting repair" on its own, with no human
 * status change. Both arrival doors call this right after their guarded
 * open → fulfilled flip, so the consequence lives in ONE place and a new
 * door cannot forget it.
 *
 * Two deliberate no-ops:
 * - The device is not in "Parts needed": a tech who pulled the device back
 *   to work while the part traveled (In progress) is not rewound by an
 *   arrival.
 * - Other open needs remain for the device: Parts needed means BLOCKED —
 *   the same rule setRepairStatus enforces on the manual unblock — so one
 *   fulfilled need does not unblock a device still waiting on others.
 */
export function autoUnblockAfterDemandFulfilled(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  deviceId: number
): void {
  const row = getDeviceLifecycleRow(db, deviceId);
  if (!row || row.repair_status !== "Parts needed") {
    return;
  }
  const open = listOpenDemandForDevice(db, deviceId);
  if (open.length > 0) {
    return;
  }
  const moved = setRepairStatus(db, clock, actor, {
    deviceId,
    to: "Awaiting repair",
    reason: "need fulfilled",
  });
  // The graph admits Parts needed → Awaiting repair on any live batch (and
  // the open-need guard above mirrors setRepairStatus's own), so a refusal
  // means the graph or the guard regressed — fail loud, never swallow.
  if (!moved.ok) {
    throw new Error(`auto-unblock after demand fulfillment was refused: ${moved.message}`);
  }
}

/**
 * Creates a batch row (sequential human number) with its opening note —
 * shared by POST /api/batches and the retriage path so both record the same
 * batch.created + note.added events.
 */
export function createBatchRecord(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  note: string
): { id: number; number: number } {
  const next = db
    .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM batches")
    .get() as { n: number };
  const now = clock.now().toISOString();
  const result = db
    .prepare("INSERT INTO batches (number, created_at, created_by) VALUES (?, ?, ?)")
    .run(next.n, now, actor.id);
  const id = Number(result.lastInsertRowid);
  recordEvent(db, clock, {
    entityType: "batch",
    entityId: id,
    actorId: actor.id,
    action: "batch.created",
    payload: { number: next.n },
  });
  recordEvent(db, clock, {
    entityType: "batch",
    entityId: id,
    actorId: actor.id,
    action: "note.added",
    payload: { text: note },
  });
  return { id, number: next.n };
}

/**
 * Retriage carry-over: a NEW batch (Awaiting approval — fresh approval
 * required), a NEW device row continuing the old one (prior_device_id link,
 * copied identifiers), and the old row's reserved parts + open demands
 * moved onto it. Called only from setRepairStatus's "Additional issues
 * present" branch, inside its transaction.
 */
function retriageDevice(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  oldDeviceId: number,
  resolutionNotes: string
): RetriageOutcome {
  const old = db
    .prepare(
      `SELECT d.*, b.number AS batch_number FROM devices d JOIN batches b ON b.id = d.batch_id WHERE d.id = ?`
    )
    .get(oldDeviceId) as Record<string, unknown> & { batch_number: number };
  const created = createBatchRecord(
    db,
    clock,
    actor,
    resolutionNotes === ""
      ? `Retriage of a device from batch #${old.batch_number} (Additional issues present)`
      : `Retriage of a device from batch #${old.batch_number} (Additional issues present): ${resolutionNotes}`
  );
  const now = clock.now().toISOString();
  // The continuation row gets the FIRST number on its new batch (ticket 30:
  // per-batch device numbers — a retriage is a fresh run).
  const nextDeviceNumber = db
    .prepare("SELECT COALESCE(MAX(device_number), 0) + 1 AS n FROM devices WHERE batch_id = ?")
    .get(created.id) as { n: number };
  const result = db
    .prepare(
      `INSERT INTO devices
         (batch_id, model_id, capacity, asset_id, imei, serial_number, stated_issue,
          notes, repair_time_minutes, repair_status, assigned_tech_id,
          triage_date, prior_device_id, device_number, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Awaiting repair', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      created.id,
      old.model_id,
      old.capacity,
      old.asset_id,
      old.imei,
      old.serial_number,
      old.stated_issue,
      old.notes,
      old.repair_time_minutes,
      old.assigned_tech_id,
      now, // a fresh Triage Date: this is the new run's triage
      oldDeviceId,
      nextDeviceNumber.n,
      now,
      now
    );
  const newDeviceId = Number(result.lastInsertRowid);

  // The parts move (still Reserved, same snapshotted prices) and the open
  // demands follow — both are batchparts-owned tables, written through
  // batchparts' own move functions, not raw SQL here. The new device row
  // starts with the DEFAULT price_add_limit_cents (0): a new batch is a new
  // approval cycle with a fresh Price Add Limit (ticket 28) — the old
  // device's limit does not carry.
  const carried = listActiveAttachmentsForDevice(db, oldDeviceId);
  const carriedParts = moveAttachmentsToDevice(db, oldDeviceId, newDeviceId);
  const carriedDemand = moveOpenDemandToDevice(db, oldDeviceId, created.id, newDeviceId);

  recordEvent(db, clock, {
    entityType: "device",
    entityId: oldDeviceId,
    actorId: actor.id,
    action: "device.retriaged",
    payload: {
      fromBatchId: old.batch_id,
      fromBatchNumber: old.batch_number,
      toBatchId: created.id,
      toBatchNumber: created.number,
      toDeviceId: newDeviceId,
      carriedParts,
      carriedDemand,
    },
  });
  recordEvent(db, clock, {
    entityType: "device",
    entityId: newDeviceId,
    actorId: actor.id,
    action: "device.retriaged_in",
    payload: {
      fromBatchId: old.batch_id,
      fromBatchNumber: old.batch_number,
      fromDeviceId: oldDeviceId,
      carriedParts,
    },
  });
  // Each carried part's own timeline records the transfer — a part changing
  // batches is never silent.
  for (const attachment of carried) {
    recordEvent(db, clock, {
      entityType: "part",
      entityId: attachment.part_id,
      actorId: actor.id,
      action: "part.transferred",
      payload: {
        serial: attachment.part_serial,
        sku: attachment.sku_name,
        fromBatchId: old.batch_id,
        fromBatchNumber: old.batch_number,
        fromDeviceId: oldDeviceId,
        toBatchId: created.id,
        toBatchNumber: created.number,
        toDeviceId: newDeviceId,
        reason: "retriage",
      },
    });
  }
  return { batchId: created.id, batchNumber: created.number, deviceId: newDeviceId };
}

/**
 * Manager approval: Awaiting approval → Open, recording the approved Parts
 * Cost total. Ticket 25: approval is now PER DEVICE — every device must
 * carry a manager's decision (approved or rejected, decided while the batch
 * was Awaiting approval); approving with undecided devices is refused
 * loudly, naming them. Rejected devices end in Denied Repair with their
 * parts returned to stock; the signed-off total covers APPROVED devices
 * only.
 */
export function approveBatch(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  batchId: number,
  // The note is OPTIONAL (the same reasoning that made the PO approval
  // note optional — the sign-off is the status change itself). A
  // given-but-blank note is refused loudly, never silently dropped; an
  // omitted note records no note in the event payload.
  note?: string
): LifecycleResult<{ totalCents: number }> {
  if (note !== undefined && note.trim() === "") {
    return {
      ok: false,
      http: 400,
      message: "an approval note, when given, cannot be blank — omit it to approve without words",
    };
  }
  const batch = db
    .prepare("SELECT id, number, status FROM batches WHERE id = ?")
    .get(batchId) as { id: number; number: number; status: string } | undefined;
  if (!batch) {
    return { ok: false, http: 404, message: "no batch with that id" };
  }
  if (batch.status !== "Awaiting approval") {
    return {
      ok: false,
      http: 409,
      message: `only a batch in Awaiting approval can be approved — this one is ${batch.status}`,
    };
  }
  const devices = db
    .prepare(
      `SELECT d.id, d.repair_status, d.approval_decision, d.approval_decision_note,
              m.name AS model_name, d.imei, d.asset_id, d.serial_number
         FROM devices d JOIN device_models m ON m.id = d.model_id
        WHERE d.batch_id = ? AND d.removed_at IS NULL
        ORDER BY d.id`
    )
    .all(batchId) as ApprovalDeviceRow[];
  // No silent default: authorization to repair is per-repair, consciously
  // given. Undecided devices are named, not skipped.
  const undecided = devices.filter((device) => device.approval_decision === null);
  if (undecided.length > 0) {
    const named = undecided.map(deviceLabel).join(", ");
    return {
      ok: false,
      http: 409,
      message: `batch #${batch.number} cannot be approved — ${undecided.length} device${
        undecided.length === 1 ? " has" : "s have"
      } no approval decision: ${named}. Decide each device (approve or reject) first.`,
    };
  }

  const run = db.transaction((): void => {
    const now = clock.now().toISOString();
    let totalCents = 0;
    const denied: Array<{ id: number; returnedParts: number }> = [];
    for (const device of devices) {
      if (device.approval_decision === "rejected") {
        // (a) The device's parts are unneeded, not damaged — every active
        // attachment returns to stock with an auto-note naming the denial.
        const returned = returnAttachmentsToStock(db, clock, actor.id, {
          deviceId: device.id,
          batchId,
          batchNumber: batch.number,
          note: DENIAL_PART_NOTE,
          reason: "batch_denied",
        });
        // (b) Denied Repair, terminal, reachable ONLY here. The lifecycle
        // module owns devices.repair_status; the graph deliberately has no
        // edge INTO Denied Repair, so this direct write inside the approval
        // transaction is the one door. The rejection's note (when the
        // manager gave one) becomes the resolution notes; without one, the
        // denial's record is the rejection event itself.
        db.prepare(
          `UPDATE devices
              SET repair_status = 'Denied Repair', resolution_notes = ?, updated_at = ?
            WHERE id = ?`
        ).run(device.approval_decision_note, now, device.id);
        recordEvent(db, clock, {
          entityType: "device",
          entityId: device.id,
          actorId: actor.id,
          action: "device.status_changed",
          payload: {
            from: device.repair_status,
            to: "Denied Repair",
            ...(device.approval_decision_note !== null
              ? { resolutionNotes: device.approval_decision_note }
              : {}),
            reason: "approval_rejected",
            returnedParts: returned.length,
          },
        });
        denied.push({ id: device.id, returnedParts: returned.length });
      } else {
        // (c) The approved cost covers approved devices only — a denied
        // device's parts went back to stock and its repair will never
        // happen, so it contributes nothing.
        totalCents += devicePartsCostCents(db, device.id);
      }
    }
    db.prepare(
      `UPDATE batches
          SET status = 'Open', approved_at = ?, approved_by = ?, approved_cost_cents = ?
        WHERE id = ?`
    ).run(now, actor.id, totalCents, batchId);
    recordEvent(db, clock, {
      entityType: "batch",
      entityId: batchId,
      actorId: actor.id,
      action: "batch.approved",
      payload: {
        totalCents,
        total: (totalCents / 100).toFixed(2),
        ...(note !== undefined && note.trim() !== "" ? { note: note.trim() } : {}),
        deniedDevices: denied,
      },
    });
  });
  run();
  return { ok: true, value: { totalCents: batchApprovedCostCents(db, batchId) } };
}

const DENIAL_PART_NOTE = "repair denied at approval — parts returned to stock";

/** A human label for an approval-blocking device: model plus its best identifier. */
function deviceLabel(device: ApprovalDeviceRow): string {
  const identifier =
    device.imei ??
    (device.asset_id ? `Asset ${device.asset_id}` : null) ??
    (device.serial_number ? `SN ${device.serial_number}` : null);
  return `${device.model_name}${identifier ? ` (${identifier})` : ` (#${device.id})`}`;
}

/**
 * The manager's per-device approval decision (ticket 25, CONTEXT.md:
 * Approval). Manager-only and Awaiting-approval-only — after the batch
 * opens, the per-device phase is over (later part changes are the
 * amendment flow). Re-deciding is allowed until the batch opens: the
 * latest decision wins, every decision is evented.
 */
export function decideDeviceApproval(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  params: {
    batchId: number;
    deviceId: number;
    decision: "approved" | "rejected";
    note?: string;
    /**
     * The optional **Price Add Limit** (ticket 28, CONTEXT.md: Approval) —
     * the post-approval spend a tech may add without further approval.
     * Omitted leaves the device's current limit (default 0 = no headroom,
     * the pre-ticket behavior). Whole cents, >= 0.
     */
    priceAddLimitCents?: number;
  }
): LifecycleResult<{ decision: string }> {
  const batch = db
    .prepare("SELECT id, number, status FROM batches WHERE id = ?")
    .get(params.batchId) as { id: number; number: number; status: string } | undefined;
  if (!batch) {
    return { ok: false, http: 404, message: "no batch with that id" };
  }
  if (batch.status !== "Awaiting approval") {
    return {
      ok: false,
      http: 409,
      message: `per-device approval decisions belong to an Awaiting-approval batch — batch #${batch.number} is ${batch.status}`,
    };
  }
  const device = db
    .prepare(
      `SELECT d.id, d.repair_status, d.price_add_limit_cents, m.name AS model_name
         FROM devices d JOIN device_models m ON m.id = d.model_id
        WHERE d.id = ? AND d.batch_id = ? AND d.removed_at IS NULL`
    )
    .get(params.deviceId, params.batchId) as
    | { id: number; repair_status: string; price_add_limit_cents: number; model_name: string }
    | undefined;
  if (!device) {
    return { ok: false, http: 404, message: "no device with that id on this batch" };
  }
  if (TERMINAL_STATUSES.has(device.repair_status as RepairStatus)) {
    return {
      ok: false,
      http: 409,
      message: `${device.repair_status} is terminal on this batch — it cannot take an approval decision`,
    };
  }
  const note = params.note?.trim() ?? "";
  // The rejection's note is OPTIONAL (a shop decision): the denial's WHY is
  // the recorded rejection itself — the `device.approval_decided` event and
  // the `approval_rejected` status change at batch approval — so the denial
  // is never silent even without free text. When a note IS given it becomes
  // the Denied Repair resolution notes, exactly as before.
  if (
    params.priceAddLimitCents !== undefined &&
    (!Number.isInteger(params.priceAddLimitCents) || params.priceAddLimitCents < 0)
  ) {
    return {
      ok: false,
      http: 400,
      message: "the price add limit must be a whole number of cents, at least 0",
    };
  }
  const run = db.transaction((): void => {
    db.prepare(
      "UPDATE devices SET approval_decision = ?, approval_decision_note = ?, price_add_limit_cents = ?, updated_at = ? WHERE id = ?"
    ).run(
      params.decision,
      note === "" ? null : note,
      params.priceAddLimitCents ?? device.price_add_limit_cents,
      clock.now().toISOString(),
      device.id
    );
    recordEvent(db, clock, {
      entityType: "device",
      entityId: device.id,
      actorId: actor.id,
      action: "device.approval_decided",
      payload: {
        decision: params.decision,
        model: device.model_name,
        ...(note !== "" ? { note } : {}),
        ...(params.priceAddLimitCents !== undefined
          ? { priceAddLimitCents: params.priceAddLimitCents }
          : {}),
      },
    });
  });
  run();
  return { ok: true, value: { decision: params.decision } };
}

/**
 * Approve ALL undecided devices on an Awaiting-approval batch at once (the
 * batch page's "Approve all devices" button). Manager-only. This is a
 * convenience over decideDeviceApproval, not a new authority: it decides
 * ONLY devices with no decision yet — a device the manager rejected keeps
 * its rejection (its note is required and becomes the Denied Repair
 * resolution notes at batch approval; silently flipping one would be a
 * silent fallback). One transaction, and every device decided here records
 * the standard device.approval_decided event, so the timeline reads the
 * same as decisions made one at a time.
 */
export function approveAllDevices(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  params: { batchId: number }
): LifecycleResult<{ approved: number }> {
  const batch = db
    .prepare("SELECT id, number, status FROM batches WHERE id = ?")
    .get(params.batchId) as { id: number; number: number; status: string } | undefined;
  if (!batch) {
    return { ok: false, http: 404, message: "no batch with that id" };
  }
  if (batch.status !== "Awaiting approval") {
    return {
      ok: false,
      http: 409,
      message: `per-device approval decisions belong to an Awaiting-approval batch — batch #${batch.number} is ${batch.status}`,
    };
  }
  const undecided = db
    .prepare(
      `SELECT d.id, d.repair_status, m.name AS model_name
         FROM devices d JOIN device_models m ON m.id = d.model_id
        WHERE d.batch_id = ? AND d.removed_at IS NULL AND d.approval_decision IS NULL
        ORDER BY d.id`
    )
    .all(params.batchId) as Array<{ id: number; repair_status: string; model_name: string }>;
  if (undecided.length === 0) {
    return {
      ok: false,
      http: 409,
      message: `batch #${batch.number} has no undecided devices — every device already carries an approval decision`,
    };
  }
  // Defensive loud failure (same terminal rule as decideDeviceApproval):
  // unreachable through the UI today — an Awaiting-approval batch cannot
  // reach a terminal status undecided — but an inconsistency must never
  // pass silently.
  const terminal = undecided.filter((device) =>
    TERMINAL_STATUSES.has(device.repair_status as RepairStatus)
  );
  if (terminal.length > 0) {
    const named = terminal.map((device) => `${device.model_name} (#${device.id})`).join(", ");
    return {
      ok: false,
      http: 409,
      message: `${named} ${
        terminal.length === 1 ? "is" : "are"
      } in a terminal status and cannot take an approval decision`,
    };
  }
  const run = db.transaction((): void => {
    const now = clock.now().toISOString();
    for (const device of undecided) {
      db.prepare(
        "UPDATE devices SET approval_decision = 'approved', approval_decision_note = NULL, updated_at = ? WHERE id = ?"
      ).run(now, device.id);
      recordEvent(db, clock, {
        entityType: "device",
        entityId: device.id,
        actorId: actor.id,
        action: "device.approval_decided",
        payload: { decision: "approved", model: device.model_name, via: "approve_all" },
      });
    }
  });
  run();
  return { ok: true, value: { approved: undecided.length } };
}

/**
 * A manager changing a device's Price Add Limit in place (ticket 28) —
 * typically after approval, when the contract's cap turns out to differ
 * from what was set at decision time. Manager-only; refused on a Closed
 * batch (its costs are final). The event records old → new; no note is
 * required (the change itself is the record), but one is carried when
 * given. Lowering below the already-spent amount is allowed — future
 * additions simply refuse; the event says what happened.
 */
export function changeDevicePriceLimit(
  db: Database.Database,
  clock: Clock,
  actor: { id: number; role: Role },
  params: {
    batchId: number;
    deviceId: number;
    priceAddLimitCents: number;
    note?: string;
  }
): LifecycleResult<{ fromCents: number; toCents: number }> {
  if (!hasManagerPowers(actor.role)) {
    return { ok: false, http: 403, message: "only a manager can change a device's price add limit" };
  }
  if (!Number.isInteger(params.priceAddLimitCents) || params.priceAddLimitCents < 0) {
    return {
      ok: false,
      http: 400,
      message: "the price add limit must be a whole number of cents, at least 0",
    };
  }
  const batch = db
    .prepare("SELECT id, number, status FROM batches WHERE id = ?")
    .get(params.batchId) as { id: number; number: number; status: string } | undefined;
  if (!batch) {
    return { ok: false, http: 404, message: "no batch with that id" };
  }
  if (batch.status === "Closed") {
    return {
      ok: false,
      http: 409,
      message: `batch #${batch.number} is Closed — its recorded costs are final, so the price add limit can no longer change`,
    };
  }
  const device = db
    .prepare(
      `SELECT d.id, d.price_add_limit_cents, m.name AS model_name
         FROM devices d JOIN device_models m ON m.id = d.model_id
        WHERE d.id = ? AND d.batch_id = ? AND d.removed_at IS NULL`
    )
    .get(params.deviceId, params.batchId) as
    | { id: number; price_add_limit_cents: number; model_name: string }
    | undefined;
  if (!device) {
    return { ok: false, http: 404, message: "no device with that id on this batch" };
  }
  const fromCents = device.price_add_limit_cents;
  const run = db.transaction((): void => {
    db.prepare(
      "UPDATE devices SET price_add_limit_cents = ?, updated_at = ? WHERE id = ?"
    ).run(params.priceAddLimitCents, clock.now().toISOString(), device.id);
    recordEvent(db, clock, {
      entityType: "device",
      entityId: device.id,
      actorId: actor.id,
      action: "device.price_limit_changed",
      payload: {
        from: fromCents,
        to: params.priceAddLimitCents,
        model: device.model_name,
        ...(params.note?.trim() ? { note: params.note.trim() } : {}),
      },
    });
  });
  run();
  return { ok: true, value: { fromCents, toCents: params.priceAddLimitCents } };
}

export type DeviceRemovalResult = LifecycleResult<{
  deviceId: number;
  returnedParts: number;
  cancelledDemand: number;
}>;

/**
 * Removing a DEVICE from its batch (ticket 30, CONTEXT.md: Device Removal).
 * Any tech, while the batch is Awaiting approval or Open; the device must be
 * non-terminal — a terminal run is part of the batch's record (its cost was
 * signed off or its parts settled at close). In ONE transaction:
 * - every active attachment returns to stock (Available) through batchparts'
 *   returnAttachmentsToStock — the same guarded write the denial uses, with
 *   its own truthful reason and the actor's note;
 * - every OPEN demand for the device becomes cancelled — a need for a repair
 *   that will not happen here. Fulfilled demand is history and untouched;
 *   already-ordered demand keeps its PO link (that order genuinely bought
 *   the part; receipt will not auto-reserve it, because pickDemand only
 *   serves 'open' records);
 * - the device row is SOFT-removed (removed_at/by/note): lists, counts,
 *   approvals, costs, and searches filter it out, but the row and its events
 *   remain — cross-batch history and part attachment history are not
 *   rewritten;
 * - on an Open batch the standing approval is amended: the signed-off total
 *   recomputes without the device.
 * A Closed batch refuses outright — its record is finished.
 */
export function removeDeviceFromBatch(
  db: Database.Database,
  clock: Clock,
  actor: { id: number; email: string },
  params: {
    batchId: number;
    deviceId: number;
    note: string;
  }
): DeviceRemovalResult {
  const note = params.note.trim();
  if (note === "") {
    return {
      ok: false,
      http: 400,
      message: "a note is required to remove a device — it records why the device left this batch",
    };
  }
  const batch = db
    .prepare("SELECT id, number, status FROM batches WHERE id = ?")
    .get(params.batchId) as { id: number; number: number; status: string } | undefined;
  if (!batch) {
    return { ok: false, http: 404, message: "no batch with that id" };
  }
  if (batch.status === "Closed") {
    return {
      ok: false,
      http: 409,
      message: `batch #${batch.number} is Closed — its record is finished and devices can no longer be removed from it`,
    };
  }
  const device = db
    .prepare(
      `SELECT d.id, d.repair_status, d.imei, d.asset_id, d.serial_number, m.name AS model_name
         FROM devices d JOIN device_models m ON m.id = d.model_id
        WHERE d.id = ? AND d.batch_id = ? AND d.removed_at IS NULL`
    )
    .get(params.deviceId, params.batchId) as
    | {
        id: number;
        repair_status: string;
        imei: string | null;
        asset_id: string | null;
        serial_number: string | null;
        model_name: string;
      }
    | undefined;
  if (!device) {
    return { ok: false, http: 404, message: "no device with that id on this batch" };
  }
  if (TERMINAL_STATUSES.has(device.repair_status as RepairStatus)) {
    return {
      ok: false,
      http: 409,
      message: `${device.repair_status} is terminal on this batch — its run is part of the batch's record and the device cannot be removed`,
    };
  }

  const run = db.transaction((): { returnedParts: number; cancelledDemand: number } => {
    const returned = returnAttachmentsToStock(db, clock, actor.id, {
      deviceId: device.id,
      batchId: params.batchId,
      batchNumber: batch.number,
      note: `device removed from batch — ${note}`,
      reason: "device_removed",
    });
    const openDemand = listOpenDemandForDevice(db, device.id);
    for (const demand of openDemand) {
      cancelDemandWithEvents(db, clock, actor, {
        demandId: demand.id,
        skuId: demand.sku_id,
        sku: demand.sku_name,
        batchId: params.batchId,
        batchNumber: batch.number,
        deviceId: device.id,
        note,
        reason: "device_removed",
      });
    }
    db.prepare("UPDATE devices SET removed_at = ?, removed_by = ?, removal_note = ?, updated_at = ? WHERE id = ?").run(
      clock.now().toISOString(),
      actor.id,
      note,
      clock.now().toISOString(),
      device.id
    );
    recordEvent(db, clock, {
      entityType: "device",
      entityId: device.id,
      actorId: actor.id,
      action: "device.removed",
      payload: {
        batchId: params.batchId,
        batchNumber: batch.number,
        model: device.model_name,
        imei: device.imei,
        assetId: device.asset_id,
        serialNumber: device.serial_number,
        returnedParts: returned.length,
        cancelledDemand: openDemand.length,
        note,
      },
    });
    if (batch.status === "Open") {
      amendApproval(db, clock, actor, params.batchId, `device removed from batch — ${note}`);
    }
    return { returnedParts: returned.length, cancelledDemand: openDemand.length };
  });
  const counts = run();
  return { ok: true, value: { deviceId: device.id, ...counts } };
}

/**
 * The Parts Cost total across a batch's devices (the number approval signs
 * off). Denied Repair devices are EXCLUDED (ticket 25): their parts went
 * back to stock at approval and their repair will never happen — they
 * contribute nothing to the approved cost, at sign-off or at any later
 * amendment. Removed devices (ticket 30) are excluded likewise: their run
 * ended and their parts returned. (Denied is reachable only at approval
 * time, so a denied device is on the batch from before the first sign-off
 * onward.)
 */
function batchApprovedCostCents(db: Database.Database, batchId: number): number {
  const rows = db
    .prepare(
      "SELECT id FROM devices WHERE batch_id = ? AND repair_status != 'Denied Repair' AND removed_at IS NULL ORDER BY id"
    )
    .all(batchId) as Array<{ id: number }>;
  return rows.reduce((sum, row) => sum + devicePartsCostCents(db, row.id), 0);
}

/**
 * A manager's post-approval part change amends the standing approval: the
 * signed-off total is recomputed and re-recorded with the required note.
 * Throws on misuse (a batch that is not Open) — callers check first, and a
 * wrong call is a programming error, not a request variant.
 */
export function amendApproval(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  batchId: number,
  note: string
): void {
  const batch = db
    .prepare("SELECT status, approved_cost_cents FROM batches WHERE id = ?")
    .get(batchId) as { status: string; approved_cost_cents: number | null } | undefined;
  if (!batch || batch.status !== "Open" || batch.approved_cost_cents === null) {
    throw new Error(
      `cannot amend the approval of batch ${batchId}: it is not an approved (Open) batch with a recorded total`
    );
  }
  const previousTotalCents = batch.approved_cost_cents;
  const totalCents = batchApprovedCostCents(db, batchId);
  db.prepare("UPDATE batches SET approved_cost_cents = ? WHERE id = ?").run(totalCents, batchId);
  recordEvent(db, clock, {
    entityType: "batch",
    entityId: batchId,
    actorId: actor.id,
    action: "batch.approval_amended",
    payload: { previousTotalCents, totalCents, note },
  });
}

/**
 * Close: Open → Closed, only when every device is terminal. Closing settles
 * the parts through batchparts' guarded writes (installed → Unavailable;
 * a Reserved part only exists as an active attachment in this schema, so
 * there is no separate "uninstalled reserved" population to return).
 */
export function closeBatch(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  batchId: number
): LifecycleResult<{ settled: number }> {
  const batch = db
    .prepare("SELECT id, number, status FROM batches WHERE id = ?")
    .get(batchId) as { id: number; number: number; status: string } | undefined;
  if (!batch) {
    return { ok: false, http: 404, message: "no batch with that id" };
  }
  if (batch.status === "Awaiting approval") {
    return {
      ok: false,
      http: 409,
      message: `batch #${batch.number} is Awaiting approval — a manager must approve it before it can be closed`,
    };
  }
  if (batch.status === "Closed") {
    return { ok: false, http: 409, message: `batch #${batch.number} is already Closed` };
  }
  // Close means done: name the blocking devices loudly instead of a vague refusal.
  // Removed devices (ticket 30) are not counted — their run ended at removal.
  const counts = db
    .prepare(
      `SELECT repair_status, COUNT(*) AS n FROM devices WHERE batch_id = ? AND removed_at IS NULL GROUP BY repair_status`
    )
    .all(batchId) as Array<{ repair_status: string; n: number }>;
  if (counts.length === 0) {
    return {
      ok: false,
      http: 409,
      message: `batch #${batch.number} has no devices — a batch with no devices cannot be closed`,
    };
  }
  const active = counts.filter((row) => !TERMINAL_STATUSES.has(row.repair_status as RepairStatus));
  if (active.length > 0) {
    const summary = active.map((row) => `${row.repair_status} (${row.n})`).join(", ");
    const total = active.reduce((sum, row) => sum + row.n, 0);
    return {
      ok: false,
      http: 409,
      message: `cannot close batch #${batch.number} — ${total} device(s) not yet terminal: ${summary}`,
    };
  }

  const run = db.transaction(() => {
    const settlement = settleBatchParts(db, clock, actor.id, batchId, batch.number);
    db.prepare(
      "UPDATE batches SET status = 'Closed', closed_at = ?, closed_by = ? WHERE id = ?"
    ).run(clock.now().toISOString(), actor.id, batchId);
    recordEvent(db, clock, {
      entityType: "batch",
      entityId: batchId,
      actorId: actor.id,
      action: "batch.closed",
      payload: {
        settled: settlement.settled.map((row) => ({
          serial: row.part_serial,
          sku: row.sku_name,
          deviceId: row.device_id,
        })),
        // Loud, not silent: these attachments were active but the part was
        // no longer Reserved (e.g. an audit close got there first) — nothing
        // was written for them and the timeline says so.
        alreadyUnavailable: settlement.alreadyUnavailable.map((row) => ({
          serial: row.part_serial,
          deviceId: row.device_id,
        })),
      },
    });
    return settlement.settled.length;
  });
  const settled = run();
  return { ok: true, value: { settled } };
}
