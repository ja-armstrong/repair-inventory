import type Database from "better-sqlite3";
import { formatCents } from "../parts/prices.js";
import type { CurrentUser } from "../auth/session.js";
import {
  allowedTransitionsFrom,
  DEVICE_COUNT_KEYS,
  emptyDeviceCounts,
  type BatchStatus,
  type RepairStatus,
} from "./statuses.js";

/**
 * Row → JSON mappers shared by the batch and device routes. The API speaks
 * CONTEXT.md vocabulary: camelCase fields, embedded model/tech/user objects,
 * exact Repair Status strings. Devices carry `allowedNextStatuses` computed
 * from the server-owned transition graph (plus the batch lifecycle state) —
 * the client renders its buttons from that, it never re-encodes the rules.
 */

export interface UserRef {
  id: number;
  email: string;
}

export interface DeviceRow {
  id: number;
  batch_id: number;
  batch_number: number;
  batch_status: string;
  model_id: number;
  model_name: string;
  capacity: string | null;
  asset_id: string | null;
  imei: string | null;
  serial_number: string | null;
  stated_issue: string;
  notes: string | null;
  // Ticket 08: the combined Loc/Bin — one optional free-text current-state
  // field (see serializeDevice). Not history: no event is ever written for it.
  loc_bin: string | null;
  repair_time_minutes: number | null;
  repair_status: string;
  resolution_notes: string | null;
  assigned_tech_id: number;
  assigned_tech_email: string;
  triage_date: string;
  prior_device_id: number | null;
  approval_decision: string | null;
  approval_decision_note: string | null;
  price_add_limit_cents: number;
  /** Stable per-batch human number ("device #8"), migration 0020 — assigned at creation, never reused. */
  device_number: number | null;
  created_at: string;
  updated_at: string;
}

export interface BatchRow {
  id: number;
  number: number;
  created_at: string;
  created_by: number;
  created_by_email: string;
  status: string;
  approved_at: string | null;
  approved_by: number | null;
  approved_by_email: string | null;
  approved_cost_cents: number | null;
  closed_at: string | null;
  closed_by: number | null;
  closed_by_email: string | null;
}

const DEVICE_BASE_SELECT = `
  SELECT d.id, d.batch_id, d.model_id, m.name AS model_name, d.capacity,
         d.asset_id, d.imei, d.serial_number, d.loc_bin, d.stated_issue, d.notes,
         d.repair_time_minutes, d.repair_status, d.resolution_notes,
         d.assigned_tech_id, u.email AS assigned_tech_email,
         d.triage_date, d.prior_device_id,
         d.approval_decision, d.approval_decision_note, d.price_add_limit_cents,
         d.device_number,
         d.created_at, d.updated_at,
         b.number AS batch_number, b.status AS batch_status
    FROM devices d
    JOIN device_models m ON m.id = d.model_id
    JOIN users u ON u.id = d.assigned_tech_id
    JOIN batches b ON b.id = d.batch_id
   WHERE d.batch_id = ? AND d.removed_at IS NULL
`;

const DEVICE_SELECT = `${DEVICE_BASE_SELECT} ORDER BY d.id`;

export function listDeviceRows(db: Database.Database, batchId: number): DeviceRow[] {
  return db.prepare(DEVICE_SELECT).all(batchId) as DeviceRow[];
}

export function getDeviceRow(
  db: Database.Database,
  batchId: number,
  deviceId: number
): DeviceRow | undefined {
  const row = db
    .prepare(`${DEVICE_BASE_SELECT} AND d.id = ?`)
    .get(batchId, deviceId) as DeviceRow | undefined;
  return row;
}

/**
 * The device's cross-batch history (spec story 27): every OTHER device row
 * matched by a shared identifier (IMEI, Asset ID, or serial number), plus
 * the retriage chain (the row this one continues, and the row that continues
 * it) even if identifiers were edited since.
 */
export function listRelatedDevices(db: Database.Database, row: DeviceRow): DeviceRow[] {
  return db
    .prepare(
      `SELECT d.id, d.batch_id, d.model_id, m.name AS model_name, d.capacity,
              d.asset_id, d.imei, d.serial_number, d.loc_bin, d.stated_issue, d.notes,
              d.repair_time_minutes, d.repair_status, d.resolution_notes,
              d.assigned_tech_id, u.email AS assigned_tech_email,
              d.triage_date, d.prior_device_id,
              d.approval_decision, d.approval_decision_note, d.price_add_limit_cents,
              d.device_number,
              d.created_at, d.updated_at,
              b.number AS batch_number, b.status AS batch_status
         FROM devices d
         JOIN device_models m ON m.id = d.model_id
         JOIN users u ON u.id = d.assigned_tech_id
         JOIN batches b ON b.id = d.batch_id
        WHERE d.id != ?
          AND d.batch_id != ?
          AND (
                (d.imei IS NOT NULL AND d.imei = ?)
             OR (d.asset_id IS NOT NULL AND d.asset_id = ?)
             OR (d.serial_number IS NOT NULL AND d.serial_number = ?)
             OR d.prior_device_id = ?
             OR d.id = ?
          )
        ORDER BY d.triage_date, d.id`
    )
    .all(
      row.id,
      row.batch_id,
      row.imei,
      row.asset_id,
      row.serial_number,
      row.id, // devices whose prior_device_id is this row
      row.prior_device_id // the row this one continues
    ) as DeviceRow[];
}

export function serializeDevice(row: DeviceRow, warnings: string[] = []) {
  return {
    id: row.id,
    batchId: row.batch_id,
    batchNumber: row.batch_number,
    model: { id: row.model_id, name: row.model_name },
    capacity: row.capacity,
    assetId: row.asset_id,
    imei: row.imei,
    serialNumber: row.serial_number,
    statedIssue: row.stated_issue,
    notes: row.notes,
    // Ticket 08: the combined Loc/Bin — where the device sits in the shop.
    // Current state, not an event: it is overwritten in place and never
    // timeline-recorded, so the field carries no history by design.
    locBin: row.loc_bin,
    repairTimeMinutes: row.repair_time_minutes,
    repairStatus: row.repair_status,
    resolutionNotes: row.resolution_notes,
    // Ticket 25: the manager's per-device approval decision while the batch
    // is Awaiting approval — null until decided; the note is the rejection's
    // future resolution notes (or an approval's optional remark).
    approvalDecision: row.approval_decision,
    approvalDecisionNote: row.approval_decision_note,
    // Ticket 28: the device's Price Add Limit (default 0 = no post-approval
    // headroom). The Open-batch headroom itself is derived spend — it rides
    // on the batch parts listing, not here.
    priceAddLimitCents: row.price_add_limit_cents,
    // Ticket 30: the stable per-batch device number ("device #8").
    deviceNumber: row.device_number,
    assignedTech: { id: row.assigned_tech_id, email: row.assigned_tech_email },
    triageDate: row.triage_date,
    priorDeviceId: row.prior_device_id,
    // The server-owned transition graph, narrowed by the batch lifecycle —
    // the client's status options, never its own copy of the rules.
    allowedNextStatuses: allowedTransitionsFrom(
      row.repair_status as RepairStatus,
      row.batch_status as BatchStatus
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    warnings,
  };
}

export const BATCH_SELECT = `
  SELECT b.id, b.number, b.created_at, b.created_by, b.status,
         b.approved_at, b.approved_by, b.approved_cost_cents,
         b.closed_at, b.closed_by,
         ua.email AS created_by_email,
         ap.email AS approved_by_email,
         cl.email AS closed_by_email
    FROM batches b
    JOIN users ua ON ua.id = b.created_by
    LEFT JOIN users ap ON ap.id = b.approved_by
    LEFT JOIN users cl ON cl.id = b.closed_by
`;

export function getBatchRow(db: Database.Database, id: number): BatchRow | undefined {
  return db.prepare(`${BATCH_SELECT} WHERE b.id = ?`).get(id) as BatchRow | undefined;
}

/**
 * The batch's OPENING note (ticket 01): the note captured at creation. It is
 * not a batches column — it lives as a timeline event, and the event
 * `createBatchRecord` writes (the batch's FIRST `note.added`, recorded
 * inside the creation transaction before the batch id can be referenced by
 * anything else) is the one source. A missing event is an inconsistency —
 * every batch is created through createBatchRecord, which always writes the
 * note — so it fails loud rather than rendering an empty cell.
 */
function openingNoteFor(db: Database.Database, batchId: number): string {
  const row = db
    .prepare(
      `SELECT payload FROM events
        WHERE entity_type = 'batch' AND entity_id = ? AND action = 'note.added'
        ORDER BY id LIMIT 1`
    )
    .get(batchId) as { payload: string | null } | undefined;
  if (row === undefined || row.payload === null) {
    throw new Error(`batch ${batchId} has no opening-note event — every batch is created with a required note, so this is an inconsistency`);
  }
  const payload = JSON.parse(row.payload) as { text?: unknown };
  if (typeof payload.text !== "string") {
    throw new Error(`batch ${batchId}'s opening-note event carries no note text — this is an inconsistency`);
  }
  return payload.text;
}

/**
 * The derived device counts: GROUP BY over the batch's devices. The device
 * counts are NEVER stored — this query is their only source of truth. (The
 * batch LIFECYCLE — approval/close — is stored state, migration 0010.)
 * Removed devices (ticket 30) are not counted: they left the batch.
 */
export function deviceCountsFor(
  db: Database.Database,
  batchId: number
): { counts: Record<string, number>; total: number } {
  const counts = emptyDeviceCounts();
  const rows = db
    .prepare("SELECT repair_status, COUNT(*) AS n FROM devices WHERE batch_id = ? AND removed_at IS NULL GROUP BY repair_status")
    .all(batchId) as { repair_status: string; n: number }[];
  for (const row of rows) {
    const key = DEVICE_COUNT_KEYS[row.repair_status as keyof typeof DEVICE_COUNT_KEYS];
    if (key !== undefined) {
      counts[key] = row.n;
    }
  }
  const total = rows.reduce((sum, row) => sum + row.n, 0);
  return { counts, total };
}

export function serializeBatchSummary(
  db: Database.Database,
  row: BatchRow
): Record<string, unknown> {
  // Loud, not blank (ticket 01): the list route once selected its own
  // columns, cast the rows `as BatchRow`, and `status` silently became
  // `undefined` — the Status column rendered empty. A summary without a
  // lifecycle status is an inconsistency, so it fails instead of passing.
  if (row.status === undefined || row.status === null) {
    throw new Error(`batch ${row.id} has no lifecycle status — this is an inconsistency`);
  }
  const { counts, total } = deviceCountsFor(db, row.id);
  return {
    id: row.id,
    number: row.number,
    createdAt: row.created_at,
    createdBy: { id: row.created_by, email: row.created_by_email },
    status: row.status,
    approvedAt: row.approved_at,
    approvedBy:
      row.approved_by === null
        ? null
        : { id: row.approved_by, email: row.approved_by_email },
    approvedCostCents: row.approved_cost_cents,
    approvedCost: row.approved_cost_cents === null ? null : formatCents(row.approved_cost_cents),
    closedAt: row.closed_at,
    closedBy:
      row.closed_by === null ? null : { id: row.closed_by, email: row.closed_by_email },
    // The creation note (ticket 01) — sourced from its event, see
    // openingNoteFor.
    openingNote: openingNoteFor(db, row.id),
    deviceCounts: counts,
    deviceTotal: total,
  };
}

/**
 * The part-edit permissions the CURRENT VIEWER has on this batch, computed
 * server-side from the lifecycle: before approval a tech edits part lists
 * freely; after approval a tech's part changes are same-SKU swaps plus
 * additions within the device's Price Add Limit (ticket 28 — the server
 * gates each addition; whether an add fits is per-request, so the UI always
 * offers the form and the refusal carries the options), plus — tickets 30 +
 * 02 — removals from ANY device on a live batch (post-approval and terminal
 * included; refused only on a Closed batch, per-request), so the UI always
 * offers it and the refusal names the batch. Any other change is a manager's,
 * note-carrying amendment. The client renders from this — it does not
 * re-encode the rule.
 */
function partEditPermissions(row: BatchRow) {
  return {
    // Ticket 28: an Open-batch add is gated per-request by the device's
    // Price Add Limit — the server refuses over-limit additions with the
    // options — so the form is always offered.
    addPart: true,
    // Tickets 30 + 02: removal is gated per-request by the batch lifecycle
    // (a tech's removal passes on any live batch, any device status; only a
    // Closed batch refuses) — same offer-and-refuse shape as addPart.
    removePart: true,
    consumable: true,
    swapPart: true,
  };
}

export function serializeBatchDetail(
  db: Database.Database,
  row: BatchRow,
  viewer: CurrentUser
): Record<string, unknown> {
  return {
    ...serializeBatchSummary(db, row),
    partEditPermissions: partEditPermissions(row),
    devices: listDeviceRows(db, row.id).map((device) => serializeDevice(device)),
  };
}

