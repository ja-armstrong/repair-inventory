import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";
import { amendApproval } from "../batches/lifecycle.js";
import { reservePart } from "../parts/status.js";
import { getBatchDevice, insertAttachment } from "./queries.js";

/**
 * THE one auto-reserve seam (ticket 09, spec decision 9): a serialized part
 * that ARRIVES to satisfy a Need to Order demand — a PO receipt today,
 * intake (ticket 10) tomorrow — is reserved onto the demanding device
 * through here and only here, so there is exactly one writer of the
 * arrival rules wherever the part comes from:
 *
 * - Batch-lifecycle gate: the demanding device's batch must not be Closed
 *   (its record is finished — nothing attaches to it). Awaiting approval
 *   stays allowed: the demand was created through the governed attach
 *   path, so the arrival completes it; there is no approval to amend yet.
 * - NO Price Add Limit gate: the demand is the approval-time intent and
 *   the arrival just makes it real (spec decision 9) — charging the
 *   arrival against post-approval spend would double-count cost the
 *   approval already intended.
 * - The approval is AMENDED in place to the part's actual price (up or
 *   down): amendApproval recomputes the signed-off total from the active
 *   attachments, so the arrival's snapshot is in the approved cost
 *   immediately and it can never go stale on an arrival. The cause note
 *   on the amendment names the arrival, so the timeline says WHY the
 *   total moved.
 *
 * A refusal is a returned result — the caller keeps going (a PO receipt
 * still completes and the demand stays open for manual resolution). A
 * throw is a lost race or a programming error and rolls the caller's
 * transaction back. Runs safely inside a caller's transaction
 * (better-sqlite3 nests via savepoints).
 *
 * The seam itself still does NOT touch the device's Repair Status — it only
 * commits the part. The status consequence rides on FULFILLMENT, which is a
 * step AFTER this seam (a refusal here leaves the demand open and the
 * device blocked): both doors call batches/lifecycle.ts
 * `autoUnblockAfterDemandFulfilled` right after their open → fulfilled
 * flip, which auto-returns a Parts-needed device to Awaiting repair when
 * the fulfilled demand was its last open need.
 */

export interface AutoReserveParams {
  batchId: number;
  deviceId: number;
  partId: number;
  serial: string;
  skuId: number;
  sku: string;
  /**
   * The unit's ACTUAL price — the attachment's snapshot and the value the
   * approval is amended to (the caller snapshots it from its own record,
   * e.g. the PO line's unit cost).
   */
  priceCents: number;
  demandId: number;
  /** Event vocabulary naming the arrival door (e.g. "po_receive"). */
  source: string;
  /** Required note identifying the arrival — the amendment's record. */
  cause: string;
  addedAt: string;
  addedBy: number;
}

export type AutoReserveResult =
  | { ok: true; attachmentId: number; approvalAmended: boolean }
  | { ok: false; http: number; message: string };

export function autoReserveOntoDemandDevice(
  db: Database.Database,
  clock: Clock,
  params: AutoReserveParams
): AutoReserveResult {
  const device = getBatchDevice(db, params.batchId, params.deviceId);
  // An open demand whose device is gone (a removed row is invisible here)
  // is an inconsistency — loud, never a silent skip: device removal cancels
  // its open demands, so reaching this throw means that invariant broke.
  if (!device) {
    throw new Error(
      `cannot auto-reserve part ${params.serial} for demand ${params.demandId}: ` +
        `device ${params.deviceId} is not an active device on batch ${params.batchId}`
    );
  }
  if (device.batch_status === "Closed") {
    return {
      ok: false,
      http: 409,
      message:
        `batch #${device.batch_number} is Closed — its record is finished and parts can no longer ` +
        `be attached to it; the part stays Available and the Need to Order record stays open for manual resolution`,
    };
  }
  const run = db.transaction((): { attachmentId: number; approvalAmended: boolean } => {
    if (!reservePart(db, params.partId)) {
      throw new Error(`failed to reserve part ${params.serial} for demand ${params.demandId}`);
    }
    const attachmentId = insertAttachment(db, {
      deviceId: params.deviceId,
      partId: params.partId,
      priceCents: params.priceCents,
      addedAt: params.addedAt,
      addedBy: params.addedBy,
    });
    recordEvent(db, clock, {
      entityType: "part",
      entityId: params.partId,
      actorId: params.addedBy,
      action: "part.reserved",
      payload: {
        serial: params.serial,
        skuId: params.skuId,
        sku: params.sku,
        batchId: params.batchId,
        batchNumber: device.batch_number,
        deviceId: params.deviceId,
        priceCents: params.priceCents,
        demandId: params.demandId,
        source: params.source,
        note: params.cause,
      },
    });
    recordEvent(db, clock, {
      entityType: "device",
      entityId: params.deviceId,
      actorId: params.addedBy,
      action: "device.part_reserved",
      payload: {
        attachmentId,
        serial: params.serial,
        skuId: params.skuId,
        sku: params.sku,
        priceCents: params.priceCents,
        demandId: params.demandId,
        source: params.source,
        note: params.cause,
      },
    });
    // Only an Open batch has a standing approval to amend; on Awaiting
    // approval the attachment simply lands (the approval comes later and
    // will count it).
    if (device.batch_status === "Open") {
      amendApproval(db, clock, { id: params.addedBy }, params.batchId, params.cause);
      return { attachmentId, approvalAmended: true };
    }
    return { attachmentId, approvalAmended: false };
  });
  const outcome = run();
  return { ok: true, ...outcome };
}
