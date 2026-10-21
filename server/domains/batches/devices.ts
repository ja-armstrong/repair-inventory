import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import type { AppContext } from "../../domain.js";
import { recordEvent } from "../auth/events.js";
import { requireManager } from "../auth/session.js";
import type { CurrentUser } from "../auth/session.js";
import { isRepairStatus } from "./statuses.js";
import { approveAllDevices, changeDevicePriceLimit, decideDeviceApproval, removeDeviceFromBatch, setRepairStatus } from "./lifecycle.js";
import { addModel } from "./models.js";
// The ONE reservation core (batchparts owns it): device creation's
// pre-attach delegates to it so there is exactly one writer of the
// part-reservation rules, whichever door a part enters through.
import { attachSkuToDevice, recordConsumableUsage } from "../batchparts/attach.js";
import { getSkuRow } from "../batchparts/queries.js";
import {
  getDeviceRow,
  listRelatedDevices,
  serializeDevice,
  type DeviceRow,
} from "./serialize.js";

/**
 * Device rows on a batch — the spreadsheet's columns. Rules enforced here:
 * - at least one identifier (IMEI, Asset ID, or serial number); each is
 *   optional individually, together ≥ 1. A duplicate IMEI is a WARNING in
 *   the response, never a refusal.
 * - Repair Status changes go through the status endpoint, which delegates to
 *   the batches domain's guarded setRepairStatus (graph + approval gate +
 *   events + retriage); field edits cannot touch it.
 * - every edit and status change records an event (recordEvent). The ONE
 *   exception is the Loc/Bin field (ticket 08): it is current state, not
 *   history — a device moves around the shop — so its edit updates the row
 *   and writes no event.
 */

/** Present-but-empty text becomes null (cleared); absent stays undefined (unchanged, PATCH only). */
const clearableText = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .optional();

const createDeviceSchema = z.object({
  modelId: z.number().int().positive().optional(),
  modelName: z.string().trim().min(1).optional(),
  capacity: clearableText,
  assetId: clearableText,
  imei: clearableText,
  serialNumber: clearableText,
  // Ticket 08: the combined Loc/Bin — one optional free-text location field.
  locBin: clearableText,
  statedIssue: z.string().trim().min(1, "a stated issue is required"),
  notes: clearableText,
  repairTimeMinutes: z.number().int().min(0).optional(),
  assignedTechId: z.number().int().positive().optional(),
  repairStatus: z.string().optional(),
  // Pre-attach (the add-device modal's "parts it will need"): each entry is
  // attached through THE cores (batchparts/attach.ts) — a SKU entry reserves
  // its oldest Available unit (or files a Need to Order when stock is
  // short); a serial entry reserves THAT exact unit; a CONSUMABLE entry
  // records usage (quantity × unit price — the item has no units to
  // reserve, its cost is what is tracked) in the same transaction. Atomic:
  // any refusal rolls the whole creation back, so the device never enters
  // the batch half-equipped.
  preAttach: z
    .array(
      z
        .object({
          skuId: z.coerce.number().int().positive().optional(),
          serial: z.string().trim().min(1).optional(),
          // Consumable entries only — usage is recorded per quantity.
          quantity: z.coerce.number().int().positive().optional(),
        })
        .refine((entry) => (entry.skuId === undefined) !== (entry.serial === undefined), {
          message: "each pre-attached part needs exactly one of a SKU id or a scanned serial",
        })
        .refine((entry) => entry.serial === undefined || entry.quantity === undefined, {
          message: "a quantity belongs to a consumable SKU — a scanned serial is a serialized unit",
        })
    )
    .max(20)
    .optional(),
  // The note each pre-attached part carries (optional; the amendment event
  // records the change when the batch is already Open).
  preAttachNote: z.string().trim().max(2000).optional(),
});

const editDeviceSchema = createDeviceSchema.extend({
  statedIssue: z.string().trim().min(1, "a stated issue is required").optional(),
  resolutionNotes: z.string().trim().min(1).optional(),
  repairStatus: z.never().optional(),
  // Pre-attach belongs to CREATION only — an edit attaching parts would
  // bypass the parts panel's explicit per-part flow, so it is refused here.
  preAttach: z.never().optional(),
  preAttachNote: z.never().optional(),
});

const statusSchema = z.object({
  repairStatus: z.string(),
  // Resolution notes are OPTIONAL; a given-but-blank value is refused
  // loudly, never silently dropped (the PO-approve contract).
  resolutionNotes: z.string().trim().min(1).optional(),
});

// Ticket 30: device removal is never silent — the note is required.
const removeDeviceSchema = z.object({
  note: z.string().trim().min(1),
});

const approvalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().optional(),
  // Ticket 28: the optional Price Add Limit (whole cents, >= 0), set with
  // the decision during Awaiting approval.
  priceAddLimitCents: z.coerce.number().int().min(0).optional(),
});

const priceLimitSchema = z.object({
  priceAddLimitCents: z.coerce.number().int().min(0),
  note: z.string().trim().max(2000).optional(),
});

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

/**
 * A pre-attach refusal aborts the WHOLE device creation (the transaction
 * rolls back — the device never enters the batch half-equipped). Carries
 * the reservation core's { http, message } out to the edge.
 */
class PreAttachRefusedError extends Error {
  constructor(
    readonly failure: { http: number; message: string }
  ) {
    super(failure.message);
  }
}

function parseId(raw: string): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

interface Identifiers {
  imei: string | null;
  assetId: string | null;
  serialNumber: string | null;
}

/** The identifier rule: each optional individually, together ≥ 1. */
function identifierProblem(fields: Identifiers): string | null {
  if (!fields.imei && !fields.assetId && !fields.serialNumber) {
    return "at least one identifier is required: IMEI, Asset ID, or serial number";
  }
  return null;
}

/** Non-blocking: a duplicate IMEI anywhere in the system is a visible warning. */
function imeiWarnings(
  ctx: AppContext,
  imei: string | null,
  excludingDeviceId?: number
): string[] {
  if (!imei) {
    return [];
  }
  const row = ctx.db
    .prepare(
      `SELECT d.id, b.number FROM devices d JOIN batches b ON b.id = d.batch_id
        WHERE d.imei = ? AND d.id != ?`
    )
    .get(imei, excludingDeviceId ?? -1) as { id: number; number: number } | undefined;
  if (!row) {
    return [];
  }
  return [
    `IMEI ${imei} already exists on another device (batch #${row.number}) — please verify this is not a duplicate entry`,
  ];
}

/** Resolves the Assigned Tech: defaults to the creator, must be an active user when set. */
function resolveTech(
  ctx: AppContext,
  techId: number | undefined,
  actorId: number
): number | string {
  if (techId === undefined) {
    return actorId;
  }
  const row = ctx.db.prepare("SELECT id FROM users WHERE id = ? AND active = 1").get(techId);
  return row ? techId : "assigned tech must be an existing active user";
}

/**
 * Resolves the Model: existing id, exact existing name, or create-by-name
 * (the device form's "new model" path — records a model.created event).
 */
function resolveModel(
  ctx: AppContext,
  actor: CurrentUser,
  modelId: number | undefined,
  modelName: string | undefined,
  fallback: number | undefined
): number | string {
  if (modelId !== undefined) {
    const row = ctx.db.prepare("SELECT id FROM device_models WHERE id = ?").get(modelId);
    return row ? modelId : "no model with that id — pick one from the list or add a new one";
  }
  if (modelName !== undefined) {
    const row = ctx.db
      .prepare("SELECT id FROM device_models WHERE name = ?")
      .get(modelName) as { id: number } | undefined;
    if (row) {
      return row.id;
    }
    return addModel(ctx.db, ctx, actor, modelName).id;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  return "a model is required — pick one from the list or add a new one";
}

export function registerDeviceRoutes(api: Router, ctx: AppContext): void {
  const devices = Router();

  devices.post("/:batchId/devices", (req, res) => {
    const parsed = createDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "invalid device row");
      return;
    }
    const data = parsed.data;
    if (data.repairStatus !== undefined && data.repairStatus !== "Awaiting repair") {
      badRequest(
        res,
        "devices start in Awaiting repair — use the status endpoint to change Repair Status"
      );
      return;
    }

    const batchId = parseId(req.params.batchId);
    const batch =
      batchId === undefined
        ? undefined
        : (ctx.db.prepare("SELECT id, status FROM batches WHERE id = ?").get(batchId) as
            | { id: number; status: string }
            | undefined);
    if (!batch) {
      res.status(404).json({ error: "no batch with that id" });
      return;
    }
    // A Closed batch is finished — its device list cannot grow.
    if (batch.status === "Closed") {
      res.status(409).json({ error: "this batch is Closed — devices can no longer be added to it" });
      return;
    }

    const identifiers: Identifiers = {
      imei: data.imei ?? null,
      assetId: data.assetId ?? null,
      serialNumber: data.serialNumber ?? null,
    };
    const problem = identifierProblem(identifiers);
    if (problem) {
      badRequest(res, problem);
      return;
    }

    const actor = req.currentUser!;
    const techId = resolveTech(ctx, data.assignedTechId, actor.id);
    if (typeof techId === "string") {
      badRequest(res, techId);
      return;
    }
    const modelId = resolveModel(ctx, actor, data.modelId, data.modelName, undefined);
    if (typeof modelId === "string") {
      badRequest(res, modelId);
      return;
    }

    const warnings = imeiWarnings(ctx, identifiers.imei);
    const now = ctx.clock.now().toISOString();
    const insert = ctx.db.transaction((): number => {
      // The device's stable per-batch number (ticket 30, migration 0020):
      // MAX+1 within THIS batch, in the same transaction as the insert so a
      // duplicate number is impossible.
      const next = ctx.db
        .prepare("SELECT COALESCE(MAX(device_number), 0) + 1 AS n FROM devices WHERE batch_id = ?")
        .get(batch.id) as { n: number };
      const result = ctx.db
        .prepare(
          `INSERT INTO devices
             (batch_id, model_id, capacity, asset_id, imei, serial_number, loc_bin, stated_issue,
              notes, repair_time_minutes, repair_status, resolution_notes,
              assigned_tech_id, triage_date, device_number, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Awaiting repair', NULL, ?, ?, ?, ?, ?)`
        )
        .run(
          batch.id,
          modelId,
          data.capacity ?? null,
          identifiers.assetId,
          identifiers.imei,
          identifiers.serialNumber,
          // Ticket 08: Loc/Bin is current state — stored on the row, never
          // evented (see the edit route for the same rule).
          data.locBin ?? null,
          data.statedIssue,
          data.notes ?? null,
          data.repairTimeMinutes ?? null,
          techId,
          now, // Triage Date auto-sets — never client-supplied.
          next.n,
          now,
          now
        );
      const deviceId = Number(result.lastInsertRowid);
      recordEvent(ctx.db, ctx.clock, {
        entityType: "device",
        entityId: deviceId,
        actorId: actor.id,
        action: "device.created",
        payload: {
          batchId: batch.id,
          model:
            (ctx.db.prepare("SELECT name FROM device_models WHERE id = ?").get(modelId) as
              | { name: string }
              | undefined)?.name ?? String(modelId),
          imei: identifiers.imei,
          assetId: identifiers.assetId,
          serialNumber: identifiers.serialNumber,
          statedIssue: data.statedIssue,
        },
      });
      // Pre-attach (optional), through THE cores — nested in THIS
      // transaction (better-sqlite3 savepoints), so the device enters the
      // batch with every entry attached (a serialized SKU entry: oldest
      // Available unit or a Need to Order when stock is short; a serial
      // entry: THAT exact unit; a consumable entry: usage at quantity ×
      // unit price), or NOTHING is created. A refusal aborts the whole
      // creation: the device never enters half-equipped.
      for (const entry of data.preAttach ?? []) {
        if (entry.skuId !== undefined) {
          // Route on the SKU's kind — serialized units are RESERVED,
          // consumables are recorded as USAGE; both are the parts domain's
          // one core for each.
          const sku = getSkuRow(ctx.db, entry.skuId);
          if (!sku) {
            throw new PreAttachRefusedError({
              http: 404,
              message: "no SKU with that id",
            });
          }
          if (entry.quantity !== undefined && sku.kind !== "consumable") {
            throw new PreAttachRefusedError({
              http: 400,
              message:
                "a quantity belongs to a consumable — serialized parts are attached one reserved unit at a time",
            });
          }
          const result =
            sku.kind === "consumable"
              ? recordConsumableUsage(ctx.db, ctx.clock, actor, {
                  batchId: batch.id,
                  deviceId,
                  skuId: sku.id,
                  quantity: entry.quantity ?? 1,
                  note: data.preAttachNote,
                })
              : attachSkuToDevice(ctx.db, ctx.clock, actor, {
                  batchId: batch.id,
                  deviceId,
                  skuId: entry.skuId,
                  note: data.preAttachNote,
                });
          if (!result.ok) {
            throw new PreAttachRefusedError(result);
          }
        } else {
          const result = attachSkuToDevice(ctx.db, ctx.clock, actor, {
            batchId: batch.id,
            deviceId,
            scannedSerial: entry.serial,
            note: data.preAttachNote,
          });
          if (!result.ok) {
            throw new PreAttachRefusedError(result);
          }
        }
      }
      return deviceId;
    });
    let deviceId: number;
    try {
      deviceId = insert();
    } catch (error) {
      if (error instanceof PreAttachRefusedError) {
        res.status(error.failure.http).json({ error: error.failure.message });
        return;
      }
      throw error;
    }
    const row = getDeviceRow(ctx.db, batch.id, deviceId) as DeviceRow;
    res.status(201).json(serializeDevice(row, warnings));
  });

  devices.patch("/:batchId/devices/:deviceId", (req, res) => {
    if (req.body !== undefined && Object.prototype.hasOwnProperty.call(req.body, "repairStatus")) {
      badRequest(res, "Repair Status cannot be edited here — use the status endpoint");
      return;
    }
    const parsed = editDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "invalid device edit");
      return;
    }
    const data = parsed.data;
    const batchId = parseId(req.params.batchId);
    const deviceId = parseId(req.params.deviceId);
    if (batchId === undefined || deviceId === undefined) {
      badRequest(res, "invalid batch or device id");
      return;
    }
    const row = getDeviceRow(ctx.db, batchId, deviceId);
    if (!row) {
      res.status(404).json({ error: "no device with that id on this batch" });
      return;
    }

    // Partial edit semantics: omitted fields keep their current values, so
    // the invariants (identifier rule, valid model/tech) hold on the MERGED row.
    const identifiers: Identifiers = {
      imei: data.imei !== undefined ? data.imei : row.imei,
      assetId: data.assetId !== undefined ? data.assetId : row.asset_id,
      serialNumber: data.serialNumber !== undefined ? data.serialNumber : row.serial_number,
    };
    const problem = identifierProblem(identifiers);
    if (problem) {
      badRequest(res, problem);
      return;
    }

    const actor = req.currentUser!;
    const techId = resolveTech(
      ctx,
      data.assignedTechId !== undefined ? data.assignedTechId : row.assigned_tech_id,
      actor.id
    );
    if (typeof techId === "string") {
      badRequest(res, techId);
      return;
    }
    const modelId = resolveModel(
      ctx,
      actor,
      data.modelId,
      data.modelName,
      row.model_id
    );
    if (typeof modelId === "string") {
      badRequest(res, modelId);
      return;
    }

    // Only fields that actually changed are updated — and the event records
    // exactly those, old → new.
    const next: Record<string, unknown> = {
      model_id: modelId,
      capacity: data.capacity !== undefined ? data.capacity : row.capacity,
      asset_id: identifiers.assetId,
      imei: identifiers.imei,
      serial_number: identifiers.serialNumber,
      stated_issue: data.statedIssue !== undefined ? data.statedIssue : row.stated_issue,
      notes: data.notes !== undefined ? data.notes : row.notes,
      repair_time_minutes:
        data.repairTimeMinutes !== undefined ? data.repairTimeMinutes : row.repair_time_minutes,
      assigned_tech_id: techId,
      resolution_notes:
        data.resolutionNotes !== undefined ? data.resolutionNotes : row.resolution_notes,
    };
    const labels: Record<string, string> = {
      model_id: "model",
      capacity: "capacity",
      asset_id: "assetId",
      imei: "imei",
      serial_number: "serialNumber",
      stated_issue: "statedIssue",
      notes: "notes",
      repair_time_minutes: "repairTimeMinutes",
      assigned_tech_id: "assignedTech",
      resolution_notes: "resolutionNotes",
    };
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const column of Object.keys(next)) {
      const current = (row as unknown as Record<string, unknown>)[column];
      if (current !== next[column]) {
        changed[labels[column]] = { from: current, to: next[column] };
      }
    }
    // Ticket 08: Loc/Bin is CURRENT STATE, not history — the device moves
    // around the shop, so a change overwrites the column and deliberately
    // writes NO timeline event (unlike the fields above, whose old → new
    // values are the story). Same PATCH semantics as the other clearable
    // text fields: absent = unchanged, present-but-empty = cleared. No note
    // is required — it is not an event-carrying change.
    const nextLocBin = data.locBin !== undefined ? data.locBin : row.loc_bin;
    const locBinChanged = data.locBin !== undefined && data.locBin !== row.loc_bin;

    const warnings = imeiWarnings(ctx, identifiers.imei, deviceId);
    const update = ctx.db.transaction((): void => {
      if (Object.keys(changed).length > 0 || locBinChanged) {
        const assignments = [
          ...Object.keys(next).map((column) => `${column} = ?`),
          ...(locBinChanged ? ["loc_bin = ?"] : []),
        ].join(", ");
        ctx.db
          .prepare(`UPDATE devices SET ${assignments}, updated_at = ? WHERE id = ?`)
          .run(
            ...Object.values(next),
            ...(locBinChanged ? [nextLocBin] : []),
            ctx.clock.now().toISOString(),
            deviceId
          );
        // Loc/Bin is intentionally absent from this payload — a loc/bin-only
        // edit writes no event at all (current state, not history).
        if (Object.keys(changed).length > 0) {
          recordEvent(ctx.db, ctx.clock, {
            entityType: "device",
            entityId: deviceId,
            actorId: actor.id,
            action: "device.edited",
            payload: { fields: changed },
          });
        }
      }
    });
    update();
    const fresh = getDeviceRow(ctx.db, batchId, deviceId) as DeviceRow;
    res.json(serializeDevice(fresh, warnings));
  });

  devices.post("/:batchId/devices/:deviceId/status", (req, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "a repair status is required (resolution notes, when given, cannot be blank)");
      return;
    }
    if (!isRepairStatus(parsed.data.repairStatus)) {
      badRequest(res, `unknown Repair Status: ${parsed.data.repairStatus}`);
      return;
    }
    const batchId = parseId(req.params.batchId);
    const deviceId = parseId(req.params.deviceId);
    if (batchId === undefined || deviceId === undefined) {
      badRequest(res, "invalid batch or device id");
      return;
    }
    const row = getDeviceRow(ctx.db, batchId, deviceId);
    if (!row) {
      res.status(404).json({ error: "no device with that id on this batch" });
      return;
    }
    const target = parsed.data.repairStatus;
    const actor = req.currentUser!;
    if (row.repair_status === target) {
      // No-op: same status, nothing to validate or record.
      res.json(serializeDevice(row));
      return;
    }
    // The guarded change owns the graph check, the approval gate, the
    // resolution-notes rule, the event, and the retriage side effect.
    const result = setRepairStatus(ctx.db, ctx.clock, actor, {
      deviceId,
      to: target,
      resolutionNotes: parsed.data.resolutionNotes,
    });
    if (!result.ok) {
      res.status(result.http).json({ error: result.message });
      return;
    }
    const fresh = getDeviceRow(ctx.db, batchId, deviceId) as DeviceRow;
    res.json({
      ...serializeDevice(fresh),
      ...(result.retriage ? { retriagedTo: result.retriage } : {}),
    });
  });

  // Removing the device from its batch (ticket 30): any tech, while the
  // batch is Awaiting approval or Open; parts back to stock, open demand
  // cancelled, row soft-removed. The rules live in lifecycle.ts
  // removeDeviceFromBatch.
  devices.post("/:batchId/devices/:deviceId/remove", (req, res) => {
    const parsed = removeDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "a note is required to remove a device from the batch");
      return;
    }
    const batchId = parseId(req.params.batchId);
    const deviceId = parseId(req.params.deviceId);
    if (batchId === undefined || deviceId === undefined) {
      badRequest(res, "invalid batch or device id");
      return;
    }
    const result = removeDeviceFromBatch(ctx.db, ctx.clock, req.currentUser!, {
      batchId,
      deviceId,
      note: parsed.data.note,
    });
    if (!result.ok) {
      res.status(result.http).json({ error: result.message });
      return;
    }
    res.json(result.value);
  });

  // The manager's per-device approval decision (ticket 25): manager-only,
  // Awaiting-approval-only, re-togglable until the batch opens; every
  // decision is evented. The rules live in lifecycle.ts decideDeviceApproval.
  devices.post("/:batchId/devices/:deviceId/approval", requireManager, (req, res) => {
    const parsed = approvalDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, 'a decision is required: { decision: "approved" | "rejected", note? }');
      return;
    }
    // With a middleware in the handler list, express' route typings widen
    // params to `string | string[]` — parse defensively (batches/index.ts
    // has the same shape).
    const batchId = parseId(Array.isArray(req.params.batchId) ? req.params.batchId[0] : req.params.batchId);
    const deviceId = parseId(
      Array.isArray(req.params.deviceId) ? req.params.deviceId[0] : req.params.deviceId
    );
    if (batchId === undefined || deviceId === undefined) {
      badRequest(res, "invalid batch or device id");
      return;
    }
    const result = decideDeviceApproval(ctx.db, ctx.clock, req.currentUser!, {
      batchId,
      deviceId,
      decision: parsed.data.decision,
      note: parsed.data.note,
      priceAddLimitCents: parsed.data.priceAddLimitCents,
    });
    if (!result.ok) {
      res.status(result.http).json({ error: result.message });
      return;
    }
    const fresh = getDeviceRow(ctx.db, batchId, deviceId) as DeviceRow;
    res.json(serializeDevice(fresh));
  });

  // Approve every undecided device at once (the batch page's "Approve all
  // devices" button): manager-only, Awaiting-approval-only — the same rules
  // as the per-device decision above. The bulk rules live in lifecycle.ts
  // approveAllDevices; decided devices (rejected ones included) are never
  // touched.
  devices.post("/:batchId/devices/approve-all", requireManager, (req, res) => {
    const batchId = parseId(
      Array.isArray(req.params.batchId) ? req.params.batchId[0] : req.params.batchId
    );
    if (batchId === undefined) {
      badRequest(res, "invalid batch id");
      return;
    }
    const result = approveAllDevices(ctx.db, ctx.clock, req.currentUser!, { batchId });
    if (!result.ok) {
      res.status(result.http).json({ error: result.message });
      return;
    }
    res.json(result.value);
  });

  // The manager's in-place Price Add Limit change (ticket 28): manager-only,
  // allowed while the batch is Awaiting approval or Open; the event records
  // old → new. The rules live in lifecycle.ts changeDevicePriceLimit.
  devices.patch("/:batchId/devices/:deviceId/price-limit", requireManager, (req, res) => {
    const parsed = priceLimitSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "a price add limit (whole cents, at least 0) is required");
      return;
    }
    // With a middleware in the handler list, express' route typings widen
    // params to `string | string[]` — parse defensively (same shape as the
    // approval route above).
    const batchId = parseId(Array.isArray(req.params.batchId) ? req.params.batchId[0] : req.params.batchId);
    const deviceId = parseId(
      Array.isArray(req.params.deviceId) ? req.params.deviceId[0] : req.params.deviceId
    );
    if (batchId === undefined || deviceId === undefined) {
      badRequest(res, "invalid batch or device id");
      return;
    }
    const result = changeDevicePriceLimit(ctx.db, ctx.clock, req.currentUser!, {
      batchId,
      deviceId,
      priceAddLimitCents: parsed.data.priceAddLimitCents,
      note: parsed.data.note,
    });
    if (!result.ok) {
      res.status(result.http).json({ error: result.message });
      return;
    }
    const fresh = getDeviceRow(ctx.db, batchId, deviceId) as DeviceRow;
    res.json(serializeDevice(fresh));
  });

  // Cross-batch device history (spec story 27): other device rows matched by
  // a shared identifier, plus the retriage chain — the context a re-repair
  // needs.
  devices.get("/:batchId/devices/:deviceId/history", (req, res) => {
    const batchId = parseId(req.params.batchId);
    const deviceId = parseId(req.params.deviceId);
    const row =
      batchId === undefined || deviceId === undefined
        ? undefined
        : getDeviceRow(ctx.db, batchId, deviceId);
    if (!row) {
      res.status(404).json({ error: "no device with that id on this batch" });
      return;
    }
    res.json({
      device: { id: row.id, imei: row.imei, assetId: row.asset_id, serialNumber: row.serial_number },
      history: listRelatedDevices(ctx.db, row).map((related) => serializeDevice(related)),
    });
  });

  api.use("/batches", devices);
}
