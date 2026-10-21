import { Router } from "express";
import type { Express, Response } from "express";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { AppContext, Domain } from "../../domain.js";
import { recordEvent } from "../auth/events.js";
import { getApiRouter } from "../auth/index.js";
import { formatCents, parsePriceToCents } from "../parts/prices.js";
import { normalizeSerial } from "../parts/serials.js";
import { movePartFromReserved, partStatusLabel, reservePart } from "../parts/status.js";
import { resolveEffectivePriceCents } from "../parts/effective-price.js";
import {
  amendIfApproved,
  attachSkuToDevice,
  recordConsumableUsage,
  removeConsumableUsage,
  terminalDeviceRefusal,
  techRemoveRefusal,
  AttachRefusedError,
} from "./attach.js";
import {
  cancelDemandWithEvents,
  closeAttachment,
  deviceIdsForBatch,
  devicePartsCostCents,
  devicePostApprovalSpendCents,
  devicePriceAddLimitCents,
  getAttachment,
  getBatchDevice,
  getBatchNumber,
  getConsumableUsage,
  getDemandRow,
  getPartById,
  getPartBySerial,
  getScannablePart,
  insertAttachment,
  listAttachmentsForBatch,
  listAttachmentsForPart,
  listConsumablesForBatch,
  listDemandForBatch,
  listOutstandingDemand,
  oldestAvailablePart,
  serializeAttachment,
  serializeConsumable,
  serializeDemand,
  serializePartAttachment,
  serializePartSummary,
  type BatchDeviceRow,
} from "./queries.js";
import { ntoEstimateLabel, openDemandEstimateCents } from "./serialize.js";

/**
 * The parts-on-batches domain (ticket 05): the parts half of a Batch.
 *
 * Adding a part to a device by SKU pulls the oldest Available serialized
 * unit and Reserves it — inside ONE transaction, with a guarded status
 * UPDATE (`... WHERE status = 'available'`), so two racing requests can
 * never both claim the same unit. better-sqlite3 runs on a single
 * synchronous connection, so requests serialize in Node itself; the guard
 * and transaction make the invariant structural, not incidental.
 *
 * When Available stock is short, the write becomes a Need to Order demand
 * record (SKU + originating batch + optional supplier link) and the device
 * auto-moves to the "Parts needed" Repair Status. Demand is listable per
 * batch and globally outstanding (ticket 07's PO form reads that queue).
 *
 * Same-SKU swaps are always allowed for any tech: the replacement unit is
 * Reserved and the old one takes a destination (Available / RMA / Damaged
 * by Tech) with a required note. Damaged by Tech attribution is the acting
 * tech — the event's actor. Removal follows the same destination + note
 * rule: a part never silently returns to stock.
 *
 * Ticket 06 layers the batch lifecycle on top (batches/lifecycle.ts owns the
 * transitions): before approval techs edit part lists freely; after approval
 * a tech's part changes are same-SKU swaps, additions gated by the device's
 * Price Add Limit (ticket 28), and — tickets 30 + 02 — removals from ANY
 * device (post-approval and terminal-but-not-absorbing included; a removal
 * only ever reduces cost, so it is a tech decision, refused only on a Closed
 * batch). Any other change is a manager's, note-carrying amendment
 * (amendApproval). Device
 * status moves here go through batches' guarded setRepairStatus — no direct
 * devices-table writes (architecture review finding D).
 *
 * Reservations happen ONLY here. The bare part-status endpoint in the parts
 * domain refuses both moving a Reserved part and making a part Reserved, so
 * the two write paths can never fight.
 */

const optionalText = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .optional();

const addPartSchema = z.object({
  // The SKU to add OR a scanned serial — exactly one. A scanned serial names
  // BOTH the exact unit and its SKU (the scan path never needs a SKU pick);
  // giving both would let them disagree, so it is refused.
  skuId: z.coerce.number().int().positive().optional(),
  serial: optionalText,
  supplier: optionalText,
  note: optionalText,
  // The part's own price (ticket 23, CONTEXT.md: Part Price) — "sourced from
  // eBay at $X". Optional; when given it becomes the reserved unit's price
  // override and the attachment snapshots it.
  price: z.union([z.string(), z.number()]).optional(),
});

const destinationSchema = z.enum(["available", "rma", "damaged_by_tech", "buyback"]);

const swapSchema = z.object({
  destination: destinationSchema,
  note: z.string().trim().min(1),
  // The optional scanned replacement serial: the swap reserves THAT exact
  // unit instead of the oldest Available one. It must be the same SKU (the
  // swap rule) and Available; blank keeps the oldest-Available pick.
  serial: optionalText,
});

const removeSchema = z.object({
  // Ticket 02: the destination is ALWAYS explicit — the ticket-27 Buyback
  // default for Buybackable SKUs is deleted. Recovery is the tech's
  // decision, never automatic; the UI dialog starts unselected and blocks
  // submission until a destination is chosen. A removal never guesses.
  destination: destinationSchema,
  note: z.string().trim().min(1),
});

// Ticket 30: a Need to Order record is cancelled with a note — the need's
// death is never silent (CONTEXT.md: Note).
const cancelDemandSchema = z.object({
  note: z.string().trim().min(1),
});

const consumableSchema = z.object({
  skuId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive(),
  note: optionalText,
});

// Consumable usage removal (cost correction) is never silent — the note is
// required, like every part removal.
const removeUsageSchema = z.object({
  note: z.string().trim().min(1),
});

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function parseId(raw: string): number | undefined {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/**
 * Expected-condition failures raised INSIDE a transaction so the whole write
 * rolls back; caught at the edge and mapped to responses. The race guard in
 * particular: a unit that was Available when we read it but not when the
 * guarded UPDATE ran — nothing was written, the caller can simply retry.
 * (The add path's refusals live in attach.ts's AttachRefusedError; the swap
 * and remove routes keep their own race/error vocabulary here.)
 */
class UnitRacedError extends Error {
  constructor() {
    super("that Available unit was claimed by another request mid-write — nothing was changed; try again");
  }
}

const REMOVAL_NOTE_MESSAGE =
  "a destination (available, rma, buyback, or damaged_by_tech) and a note are required — a part never leaves a batch silently";

/**
 * The remove gate (CONTEXT.md: Approval, tickets 30 + 02) — the HTTP edge
 * over the shared non-HTTP gate in attach.ts (the consumable-usage removal
 * core uses the same rule). Returns true (and writes the status) when the
 * change is refused.
 */
function partEditRefusal(
  res: Response,
  device: BatchDeviceRow,
  kind: "remove"
): boolean {
  const refusal = techRemoveRefusal(device);
  if (refusal === null) {
    return false;
  }
  res.status(refusal.http).json({ error: refusal.message });
  return true;
}

export const batchPartsDomain: Domain = {
  name: "batchparts",
  register(app: Express, ctx: AppContext) {
    const api = getApiRouter(app);

    const batches = Router();
    const parts = Router();
    const demand = Router();

    // ---- add a part to a device by SKU or scanned serial --------------------

    // The thin HTTP edge: parse, delegate to THE reservation core
    // (batchparts/attach.ts — the same core device creation's pre-attach
    // uses), then shape the response. Every rule lives in the core.
    batches.post("/:batchId/devices/:deviceId/parts", (req, res) => {
      const parsed = addPartSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a SKU is required — pick the part kind to add to this device");
        return;
      }
      const data = parsed.data;
      if (data.skuId !== undefined && data.serial !== undefined) {
        badRequest(
          res,
          "give either a SKU or a scanned serial, not both — the scan names the exact unit, and the unit's own SKU drives the add"
        );
        return;
      }
      if (data.skuId === undefined && data.serial === undefined) {
        badRequest(
          res,
          "a SKU or a scanned serial is required — pick the part kind, or scan the unit's serial to add that exact unit"
        );
        return;
      }
      const batchId = parseId(req.params.batchId);
      const deviceId = parseId(req.params.deviceId);
      if (batchId === undefined || deviceId === undefined) {
        badRequest(res, "invalid batch or device id");
        return;
      }
      // The optional per-part price (ticket 23): parsed at the edge. Invalid
      // amounts refuse before anything is written.
      const priceCents =
        data.price === undefined ? undefined : parsePriceToCents(data.price as string | number);
      if (priceCents === null) {
        badRequest(res, "price must be a non-negative amount with at most two decimal places");
        return;
      }

      const result = attachSkuToDevice(ctx.db, ctx.clock, req.currentUser!, {
        batchId,
        deviceId,
        skuId: data.skuId,
        scannedSerial: data.serial,
        supplier: data.supplier,
        note: data.note,
        priceCentsOverride: priceCents,
      });
      if (!result.ok) {
        res.status(result.http).json({ error: result.message });
        return;
      }

      if (result.outcome.kind === "demand") {
        const row = getDemandRow(ctx.db, result.outcome.id);
        res.status(201).json({ outcome: "need_to_order", demand: serializeDemand(row!) });
      } else {
        const row = getAttachment(ctx.db, result.outcome.id);
        res.status(201).json({ outcome: "reserved", attachment: serializeAttachment(row!) });
      }
    });

    // ---- consumable usage ---------------------------------------------------

    // The thin HTTP edge over THE consumable-usage core (batchparts/
    // attach.ts recordConsumableUsage — the same core device creation's
    // pre-attach uses for consumable entries). Every rule lives in the core.
    batches.post("/:batchId/devices/:deviceId/consumables", (req, res) => {
      const parsed = consumableSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a consumable SKU and a whole-number quantity of at least 1 are required");
        return;
      }
      const batchId = parseId(req.params.batchId);
      const deviceId = parseId(req.params.deviceId);
      if (batchId === undefined || deviceId === undefined) {
        badRequest(res, "invalid batch or device id");
        return;
      }
      const result = recordConsumableUsage(ctx.db, ctx.clock, req.currentUser!, {
        batchId,
        deviceId,
        skuId: parsed.data.skuId,
        quantity: parsed.data.quantity,
        note: parsed.data.note,
      });
      if (!result.ok) {
        res.status(result.http).json({ error: result.message });
        return;
      }
      const cost = devicePartsCostCents(ctx.db, deviceId);
      res.status(201).json({
        usage: serializeConsumable(getConsumableUsage(ctx.db, result.usageId)!),
        partsCostCents: cost,
        partsCost: formatCents(cost),
      });
    });

    // ---- remove consumable usage (cost correction) --------------------------

    // The thin edge over removeConsumableUsage (attach.ts): required note,
    // same gates as part removal, soft-removed row + event. A part's cost
    // never leaves a device silently — recorded usage is no different.
    batches.post(
      "/:batchId/devices/:deviceId/consumables/:usageId/remove",
      (req, res) => {
        const parsed = removeUsageSchema.safeParse(req.body);
        if (!parsed.success) {
          badRequest(res, "a note is required to remove consumable usage — it records why the cost moved");
          return;
        }
        const batchId = parseId(req.params.batchId);
        const deviceId = parseId(req.params.deviceId);
        const usageId = parseId(req.params.usageId);
        if (batchId === undefined || deviceId === undefined || usageId === undefined) {
          badRequest(res, "invalid batch, device, or usage id");
          return;
        }
        const result = removeConsumableUsage(ctx.db, ctx.clock, req.currentUser!, {
          batchId,
          deviceId,
          usageId,
          note: parsed.data.note,
        });
        if (!result.ok) {
          res.status(result.http).json({ error: result.message });
          return;
        }
        const cost = devicePartsCostCents(ctx.db, deviceId);
        res.json({
          removed: { usageId: result.usageId, sku: result.sku, quantity: result.quantity },
          partsCostCents: cost,
          partsCost: formatCents(cost),
        });
      },
    );

    // ---- same-SKU swap --------------------------------------------------------

    batches.post("/:batchId/devices/:deviceId/parts/:attachmentId/swap", (req, res) => {
      const parsed = swapSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, REMOVAL_NOTE_MESSAGE);
        return;
      }
      const ids = parseSwapRemoveIds(req.params);
      if (!ids) {
        badRequest(res, "invalid batch, device, or attachment id");
        return;
      }
      const { batchId, deviceId, attachmentId } = ids;
      const device = getBatchDevice(ctx.db, batchId, deviceId);
      if (!device) {
        res.status(404).json({ error: "no device with that id on this batch" });
        return;
      }
      const swapTerminal = terminalDeviceRefusal(device);
      if (swapTerminal) {
        res.status(swapTerminal.http).json({ error: swapTerminal.message });
        return;
      }
      const attachment = getAttachment(ctx.db, attachmentId);
      if (!attachment || attachment.device_id !== deviceId) {
        res.status(404).json({ error: "no attachment with that id on this device" });
        return;
      }
      if (attachment.removed_at !== null) {
        res.status(409).json({ error: "that part was already removed from this device" });
        return;
      }
      // The scanned replacement (optional): the swap reserves THAT exact
      // unit. It must exist, be the SAME SKU (the swap rule), and be
      // Available; blank keeps the oldest-Available pick.
      const scannedReplacement =
        parsed.data.serial === undefined
          ? undefined
          : getScannablePart(ctx.db, normalizeSerial(parsed.data.serial));
      if (parsed.data.serial !== undefined && !scannedReplacement) {
        res
          .status(404)
          .json({ error: `no serialized part with serial ${normalizeSerial(parsed.data.serial)}` });
        return;
      }
      if (scannedReplacement && scannedReplacement.sku_id !== attachment.sku_id) {
        res.status(409).json({
          error: `serial ${scannedReplacement.serial} is a ${scannedReplacement.sku_name} unit, but the part on the device is a ${attachment.sku_name} — a swap must be same-SKU`,
        });
        return;
      }
      if (scannedReplacement && scannedReplacement.status !== "available") {
        res.status(409).json({
          error: `serial ${scannedReplacement.serial} is ${partStatusLabel(scannedReplacement.status)}, not Available — only an Available unit can be swapped in`,
        });
        return;
      }
      // A friendly pre-check for the common (unscanned) case; the
      // transaction re-checks.
      if (!scannedReplacement && !oldestAvailablePart(ctx.db, attachment.sku_id)) {
        res.status(409).json({
          error: `no Available ${attachment.sku_name} to swap in — the reserved unit is untouched; add the part again once stock arrives to file a Need to Order record`,
        });
        return;
      }

      const actor = req.currentUser!;
      const batchNumber = getBatchNumber(ctx.db, batchId);
      const destination = parsed.data.destination;
      const note = parsed.data.note;

      const swap = ctx.db.transaction((): { attachmentId: number; oldPartId: number } => {
        const replacement = scannedReplacement
          ? getScannablePart(ctx.db, scannedReplacement.serial)
          : oldestAvailablePart(ctx.db, attachment.sku_id);
        if (!replacement) {
          throw scannedReplacement
            ? new AttachRefusedError(
                `no serialized part with serial ${scannedReplacement.serial}`,
                404
              )
            : new UnitRacedError();
        }
        if (!reservePart(ctx.db, replacement.id)) {
          // A scanned replacement that lost the race out of Available says
          // so about the serial — the tech must know THAT unit is gone.
          throw scannedReplacement
            ? new AttachRefusedError(
                `serial ${replacement.serial} is no longer Available — nothing was changed`,
                409
              )
            : new UnitRacedError();
        }
        if (!movePartFromReserved(ctx.db, attachment.part_id, destination)) {
          throw new UnitRacedError();
        }
        const now = ctx.clock.now().toISOString();
        closeAttachment(ctx.db, attachmentId, {
          removedAt: now,
          removedBy: actor.id,
          removedTo: destination,
          removalNote: note,
          removalReason: "swap",
        });
        const replacementAttachmentId = insertAttachment(ctx.db, {
          deviceId,
          partId: replacement.id,
          // Ticket 23: the replacement snapshots ITS OWN effective price —
          // the replacement unit's override if it has one, else the SKU
          // price. The swap never re-prices the unit; it prices what arrived.
          priceCents: resolveEffectivePriceCents(replacement.price_cents, attachment.sku_price_cents),
          addedAt: now,
          addedBy: actor.id,
        });

        const skuRef = { skuId: attachment.sku_id, sku: attachment.sku_name };
        recordEvent(ctx.db, ctx.clock, {
          entityType: "part",
          entityId: attachment.part_id,
          actorId: actor.id,
          action: "part.removed",
          payload: {
            serial: attachment.part_serial,
            ...skuRef,
            batchId,
            batchNumber,
            deviceId,
            from: "reserved",
            to: destination,
            reason: "swap",
            note,
            swappedWith: replacement.serial,
            ...(destination === "damaged_by_tech" ? { attribution: actor.email } : {}),
          },
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "part",
          entityId: replacement.id,
          actorId: actor.id,
          action: "part.reserved",
          payload: {
            serial: replacement.serial,
            ...skuRef,
            batchId,
            batchNumber,
            deviceId,
            priceCents: resolveEffectivePriceCents(replacement.price_cents, attachment.sku_price_cents),
            ...(replacement.price_cents !== null ? { priceOverridden: true } : {}),
            swappedFor: attachment.part_serial,
            ...(scannedReplacement ? { via: "serial_scan" } : {}),
          },
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "device",
          entityId: deviceId,
          actorId: actor.id,
          action: "device.part_swapped",
          payload: {
            from: attachment.part_serial,
            to: replacement.serial,
            ...skuRef,
            destination,
            note,
          },
        });
        return { attachmentId: replacementAttachmentId, oldPartId: attachment.part_id };
      });

      let result;
      try {
        result = swap();
      } catch (error) {
        if (error instanceof AttachRefusedError) {
          res.status(error.http).json({ error: error.message });
          return;
        }
        if (error instanceof UnitRacedError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }

      res.status(201).json({
        outcome: "swapped",
        attachment: serializeAttachment(getAttachment(ctx.db, result.attachmentId)!),
        oldPart: serializePartSummary(getPartById(ctx.db, result.oldPartId)!),
      });
    });

    // ---- removal ------------------------------------------------------------

    batches.post("/:batchId/devices/:deviceId/parts/:attachmentId/remove", (req, res) => {
      const parsed = removeSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, REMOVAL_NOTE_MESSAGE);
        return;
      }
      const ids = parseSwapRemoveIds(req.params);
      if (!ids) {
        badRequest(res, "invalid batch, device, or attachment id");
        return;
      }
      const { batchId, deviceId, attachmentId } = ids;
      const device = getBatchDevice(ctx.db, batchId, deviceId);
      if (!device) {
        res.status(404).json({ error: "no device with that id on this batch" });
        return;
      }
      // Ticket 02: NO terminal-device gate here — the relaxation applies to
      // REMOVAL only. A tech may recover a part from a terminal-but-not-
      // absorbing device (Repaired / Unrepairable / Additional issues
      // present) on a live batch; attach and swap keep the terminal gate,
      // and the techRemoveRefusal gate below still refuses a Closed batch.
      if (partEditRefusal(res, device, "remove")) {
        return;
      }
      const attachment = getAttachment(ctx.db, attachmentId);
      if (!attachment || attachment.device_id !== deviceId) {
        res.status(404).json({ error: "no attachment with that id on this device" });
        return;
      }
      if (attachment.removed_at !== null) {
        res.status(409).json({ error: "that part was already removed from this device" });
        return;
      }

      const actor = req.currentUser!;
      const batchNumber = device.batch_number;
      const note = parsed.data.note;
      // Ticket 02: the destination is always explicit — the schema makes it
      // required, so there is no Buybackable default to apply (ticket 27's
      // default is deleted). A removal never guesses where a part went.
      const destination = parsed.data.destination;

      const remove = ctx.db.transaction((): void => {
        if (!movePartFromReserved(ctx.db, attachment.part_id, destination)) {
          throw new UnitRacedError();
        }
        closeAttachment(ctx.db, attachmentId, {
          removedAt: ctx.clock.now().toISOString(),
          removedBy: actor.id,
          removedTo: destination,
          removalNote: note,
          removalReason: "removal",
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "part",
          entityId: attachment.part_id,
          actorId: actor.id,
          action: "part.removed",
          payload: {
            serial: attachment.part_serial,
            skuId: attachment.sku_id,
            sku: attachment.sku_name,
            batchId,
            batchNumber,
            deviceId,
            from: "reserved",
            to: destination,
            reason: "removal",
            note,
            ...(destination === "damaged_by_tech" ? { attribution: actor.email } : {}),
          },
        });
        recordEvent(ctx.db, ctx.clock, {
          entityType: "device",
          entityId: deviceId,
          actorId: actor.id,
          action: "device.part_removed",
          payload: {
            serial: attachment.part_serial,
            skuId: attachment.sku_id,
            sku: attachment.sku_name,
            destination,
            note,
          },
        });
        amendIfApproved(ctx.db, ctx.clock, actor, device, note, true);
      });

      try {
        remove();
      } catch (error) {
        if (error instanceof UnitRacedError) {
          res.status(409).json({ error: error.message });
          return;
        }
        throw error;
      }

      res.json({ attachment: serializeAttachment(getAttachment(ctx.db, attachmentId)!) });
    });

    // ---- cancel a Need to Order record (ticket 30) ---------------------------

    // The demand is the device's BLOCK on this batch; cancelling it records
    // that the need went away (customer cancelled, wrong SKU, repair dropped)
    // without removing anything physical. Any tech, pre- or post-approval —
    // a demand is an estimate, not a signed-off cost, so it never amends the
    // approval. A Closed batch refuses: its record is finished.
    batches.post("/:batchId/devices/:deviceId/demand/:demandId/cancel", (req, res) => {
      const parsed = cancelDemandSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a note is required to cancel a Need to Order record — it says why the need went away");
        return;
      }
      const batchId = parseId(req.params.batchId);
      const deviceId = parseId(req.params.deviceId);
      const demandId = parseId(req.params.demandId);
      if (batchId === undefined || deviceId === undefined || demandId === undefined) {
        badRequest(res, "invalid batch, device, or demand id");
        return;
      }
      const device = getBatchDevice(ctx.db, batchId, deviceId);
      if (!device) {
        res.status(404).json({ error: "no device with that id on this batch" });
        return;
      }
      if (device.batch_status === "Closed") {
        res.status(409).json({
          error: `batch #${device.batch_number} is Closed — its record is finished and demand can no longer be cancelled`,
        });
        return;
      }
      const demand = getDemandRow(ctx.db, demandId);
      if (!demand || demand.batch_id !== batchId || demand.device_id !== deviceId) {
        res.status(404).json({ error: "no Need to Order record with that id on this device" });
        return;
      }
      if (demand.status !== "open") {
        res.status(409).json({ error: `that demand is already ${demand.status}` });
        return;
      }

      const actor = req.currentUser!;
      const note = parsed.data.note;
      try {
        const cancel = ctx.db.transaction((): void => {
          cancelDemandWithEvents(ctx.db, ctx.clock, actor, {
            demandId,
            skuId: demand.sku_id,
            sku: demand.sku_name,
            batchId,
            batchNumber: device.batch_number,
            deviceId,
            note,
          });
        });
        cancel();
      } catch (error) {
        if (error instanceof UnitRacedError) {
          res.status(409).json({ error: "that demand changed under this request — nothing was cancelled; reload and try again" });
          return;
        }
        throw error;
      }
      res.json({ demand: serializeDemand(getDemandRow(ctx.db, demandId)!) });
    });

    // ---- reads ----------------------------------------------------------------

    batches.get("/:batchId/parts", (req, res) => {
      const batchId = parseId(req.params.batchId);
      if (batchId === undefined || !batchExists(ctx.db, batchId)) {
        res.status(404).json({ error: "no batch with that id" });
        return;
      }
      const deviceIds = deviceIdsForBatch(ctx.db, batchId);
      const attachments = listAttachmentsForBatch(ctx.db, batchId);
      const consumables = listConsumablesForBatch(ctx.db, batchId);
      const demands = listDemandForBatch(ctx.db, batchId);
      res.json({
        batchId,
        devices: deviceIds.map((id) => {
          const cost = devicePartsCostCents(ctx.db, id);
          // Ticket 28: the device's Price Add Limit and its DERIVED
          // post-approval spend, so the add-part flow can show the remaining
          // headroom (which may go negative when a manager's in-place
          // addition pushed past the limit).
          const limit = devicePriceAddLimitCents(ctx.db, id);
          const spend = devicePostApprovalSpendCents(ctx.db, id);
          const deviceDemand = demands.filter((row) => row.device_id === id);
          const estimate = openDemandEstimateCents(deviceDemand);
          return {
            deviceId: id,
            parts: attachments.filter((row) => row.device_id === id).map(serializeAttachment),
            consumables: consumables.filter((row) => row.device_id === id).map(serializeConsumable),
            demand: deviceDemand.map(serializeDemand),
            partsCostCents: cost,
            partsCost: formatCents(cost),
            // Ticket 06: the open demands' SKU-price estimate rides along as
            // its OWN field — a demand is an estimate, not a signed-off cost,
            // so it must stay OUT of partsCostCents (and approved_cost_cents);
            // ticket 09's arrival amendment makes it real.
            openDemandEstimateCents: estimate,
            openDemandEstimate: ntoEstimateLabel(estimate),
            priceAddLimitCents: limit,
            postApprovalSpendCents: spend,
            priceAddRemainingCents: limit - spend,
          };
        }),
      });
    });

    batches.get("/:batchId/demand", (req, res) => {
      const batchId = parseId(req.params.batchId);
      if (batchId === undefined || !batchExists(ctx.db, batchId)) {
        res.status(404).json({ error: "no batch with that id" });
        return;
      }
      res.json({ demand: listDemandForBatch(ctx.db, batchId).map(serializeDemand) });
    });

    // The global outstanding Need to Order queue — the ONE outstanding-demand
    // definition (queries.ts, including the purchase_order_demand
    // subtraction). The PO form prompts from GET /api/purchase-orders/demand,
    // which serves this same shared query (final review F1); received parts
    // auto-reserve back to the originating batch in ticket 08.
    demand.get("/", (_req, res) => {
      res.json({ demand: listOutstandingDemand(ctx.db).map(serializeDemand) });
    });

    // A part's full attachment history: every batch/device it was ever
    // attached to, past attachments included (spec story 12). Mounted under
    // /parts AFTER the parts domain's own router (bootstrap order): that
    // router's GET /:serial and POST /:serial/status match ONE segment
    // only, so this two-segment path is never shadowed by them — the
    // dependency is the single-segment shape, not the mount order. Pinned
    // by "resolves both the one-segment part route and the two-segment
    // attachments route" in parts.test.ts.
    parts.get("/:serial/attachments", (req, res) => {
      const serial = normalizeSerial(req.params.serial);
      const part = getPartBySerial(ctx.db, serial);
      if (!part) {
        res.status(404).json({ error: `no serialized part with serial ${serial}` });
        return;
      }
      res.json({
        serial: part.serial,
        attachments: listAttachmentsForPart(ctx.db, part.id).map(serializePartAttachment),
      });
    });

    api.use("/batches", batches);
    api.use("/parts", parts);
    api.use("/demand", demand);
  },
};

function parseSwapRemoveIds(params: Record<string, string>): {
  batchId: number;
  deviceId: number;
  attachmentId: number;
} | undefined {
  const batchId = parseId(params.batchId);
  const deviceId = parseId(params.deviceId);
  const attachmentId = parseId(params.attachmentId);
  if (batchId === undefined || deviceId === undefined || attachmentId === undefined) {
    return undefined;
  }
  return { batchId, deviceId, attachmentId };
}

function batchExists(db: Database.Database, batchId: number): boolean {
  return db.prepare("SELECT 1 FROM batches WHERE id = ?").get(batchId) !== undefined;
}
