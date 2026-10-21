import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";
import { amendApproval } from "../batches/lifecycle.js";
import { hasManagerPowers, type CurrentUser } from "../auth/session.js";

/**
 * The per-part price module (ticket 23) — the ONE place the effective price
 * exists and the ONE owner of `serialized_parts.price_cents` writes outside
 * a part's birth (intake and PO receipt stamp the column in their INSERT;
 * this module owns every later change).
 *
 * Vocabulary per CONTEXT.md, **Part Price**: a serialized part's own price,
 * defaulting to its SKU price until overridden (e.g. an eBay-sourced unit).
 * NULL in the column means "use the SKU's current price" — so a part with no
 * override FOLLOWS the catalog when the SKU is repriced; a value pins the
 * part to its own price. The device's Parts Cost uses the price snapshotted
 * on the device_parts attachment, which is written at reservation and kept
 * equal to the part's effective price for as long as the attachment is
 * active — that is what makes an override move a device's cost (and, post-
 * approval, the amended approval total) instead of silently diverging from
 * the part's timeline.
 *
 * Locking rules (each with its WHY):
 * - Unattached part: any user may set or change the price — the part's price
 *   is stock data, and stock data is editable by the shop floor.
 * - Active attachment on an Awaiting-approval batch: any user may set/change.
 *   The batch's approval has not happened yet, so there is no signed-off
 *   number to protect — the snapshot update below simply keeps the cost the
 *   manager is about to approve truthful.
 * - Active attachment on an Open batch: manager-only, note required, through
 *   the amendment flow — the approved cost is a manager's sign-off, and
 *   moving it is exactly what amendApproval records. Same rule as every
 *   other post-approval part change (CONTEXT.md: Approval).
 * - Active attachment on a Closed batch: refused for everyone — the batch's
 *   final cost is history; the part is settled and its price is part of the
 *   closed record.
 * Refusals name the batch (number and status) — never a vague denial.
 */

/** The effective price: the part's own override, else its SKU's price. One definition, tested on both branches. */
export function resolveEffectivePriceCents(
  overrideCents: number | null,
  skuPriceCents: number
): number {
  return overrideCents ?? skuPriceCents;
}

export interface PartPrice {
  partId: number;
  serial: string;
  /** The part's own override; null = follow the SKU price. */
  overrideCents: number | null;
  skuPriceCents: number;
  effectiveCents: number;
}

/** Reads a part's price facts (override, SKU price, effective price) in one query. */
export function readPartPrice(
  db: Database.Database,
  partId: number
): PartPrice | undefined {
  const row = db
    .prepare(
      `SELECT p.id AS part_id, p.serial, p.price_cents AS override_cents, s.price_cents AS sku_price_cents
         FROM serialized_parts p JOIN skus s ON s.id = p.sku_id
        WHERE p.id = ?`
    )
    .get(partId) as
    | { part_id: number; serial: string; override_cents: number | null; sku_price_cents: number }
    | undefined;
  if (!row) {
    return undefined;
  }
  return {
    partId: row.part_id,
    serial: row.serial,
    overrideCents: row.override_cents,
    skuPriceCents: row.sku_price_cents,
    effectiveCents: resolveEffectivePriceCents(row.override_cents, row.sku_price_cents),
  };
}

/**
 * Stamps the override column on an existing part — the primitive for writers
 * that set a price at part-creation-or-reservation time (batch add-part).
 * Intake and PO receipt stamp the column in their INSERT instead; this is
 * for a part row that already exists. Loud when the part is gone.
 */
export function stampPartPriceOverride(
  db: Database.Database,
  partId: number,
  overrideCents: number | null
): void {
  const changed = db
    .prepare("UPDATE serialized_parts SET price_cents = ? WHERE id = ?")
    .run(overrideCents, partId).changes;
  if (changed !== 1) {
    throw new Error(`part ${partId} vanished while stamping its price override`);
  }
}

export type SetPartPriceResult =
  | {
      ok: true;
      partId: number;
      serial: string;
      /** Effective price before and after the change (what the part displayed). */
      fromCents: number;
      toCents: number;
      /** Set when an Open-batch amendment was recorded in the same transaction. */
      amendedBatchId: number | null;
    }
  | { ok: false; http: number; message: string };

interface ActiveAttachmentRow {
  attachment_id: number;
  batch_id: number;
  batch_number: number;
  batch_status: string;
}

/**
 * The part's active attachment with its carrying batch, for the locking
 * rules. A part can be actively attached to at most one device (reservation
 * is exclusive); more than one row is a data inconsistency and fails loudly.
 */
function activeAttachment(
  db: Database.Database,
  partId: number
): ActiveAttachmentRow | null {
  const rows = db
    .prepare(
      `SELECT dp.id AS attachment_id, b.id AS batch_id, b.number AS batch_number, b.status AS batch_status
         FROM device_parts dp
         JOIN devices d ON d.id = dp.device_id
         JOIN batches b ON b.id = d.batch_id
        WHERE dp.part_id = ? AND dp.removed_at IS NULL`
    )
    .all(partId) as ActiveAttachmentRow[];
  if (rows.length > 1) {
    throw new Error(
      `part ${partId} has ${rows.length} active attachments — a reserved part belongs to exactly one device; the data is inconsistent`
    );
  }
  return rows[0] ?? null;
}

/**
 * Sets (or clears — `overrideCents: null` re-follows the SKU) a part's price
 * with the full locking rules, keeps the active attachment's snapshot equal
 * to the new effective price, records the `part.price_changed` event
 * (old → new, effective and override), and — on an Open batch — amends the
 * standing approval in the same transaction. Transaction-composable.
 *
 * The note is required from every caller: this is the part-detail re-price
 * door, and the note is its record. Request-level failures return a failure
 * object; inconsistencies throw.
 */
export function setPartPrice(
  db: Database.Database,
  clock: Clock,
  actor: CurrentUser,
  params: {
    partId: number;
    /** The new override in cents; null clears the override (back to SKU price). */
    overrideCents: number | null;
    note: string;
  }
): SetPartPriceResult {
  const note = params.note.trim();
  if (note === "") {
    return { ok: false, http: 400, message: "a note is required to change a part's price — the note is the change's record" };
  }
  const price = readPartPrice(db, params.partId);
  if (!price) {
    return { ok: false, http: 404, message: `no serialized part with id ${params.partId}` };
  }
  const attachment = activeAttachment(db, params.partId);
  if (attachment && attachment.batch_status !== "Awaiting approval") {
    // The approved-cost window: Open is manager-only via the amendment flow;
    // Closed is final for everyone. Anything else is a status the graph
    // does not have — throw rather than guess.
    if (attachment.batch_status === "Closed") {
      return {
        ok: false,
        http: 409,
        message: `batch #${attachment.batch_number} is Closed — its recorded cost is final, so part ${price.serial}'s price can no longer change`,
      };
    }
    if (attachment.batch_status !== "Open") {
      throw new Error(
        `unknown batch status "${attachment.batch_status}" on the attachment carrying part ${price.serial}`
      );
    }
    if (!hasManagerPowers(actor.role)) {
      return {
        ok: false,
        http: 403,
        message: `this part is attached to batch #${attachment.batch_number}, which is approved (Open) — a tech cannot re-price it; a manager can change the price in place with a note (amending the approval), or the device can be retriaged onto a new batch`,
      };
    }
  }

  const toCents = resolveEffectivePriceCents(params.overrideCents, price.skuPriceCents);
  const run = db.transaction((): SetPartPriceResult => {
    stampPartPriceOverride(db, params.partId, params.overrideCents);
    // The active attachment's snapshot follows the part's effective price —
    // Parts Cost and the approval total read the snapshot, so a price change
    // that did not touch it would be invisible to every cost the batch signs.
    if (attachment) {
      db.prepare("UPDATE device_parts SET price_cents = ? WHERE id = ?").run(
        toCents,
        attachment.attachment_id
      );
    }
    recordEvent(db, clock, {
      entityType: "part",
      entityId: params.partId,
      actorId: actor.id,
      action: "part.price_changed",
      payload: {
        serial: price.serial,
        from: price.effectiveCents,
        to: toCents,
        overrideFrom: price.overrideCents,
        overrideTo: params.overrideCents,
        skuPriceCents: price.skuPriceCents,
        note,
        ...(attachment ? { batchId: attachment.batch_id, batchNumber: attachment.batch_number } : {}),
      },
    });
    // Post-approval re-price moves the approved cost — the note IS the
    // amendment's record, so the amendment carries it too.
    let amendedBatchId: number | null = null;
    if (attachment && attachment.batch_status === "Open") {
      amendApproval(db, clock, actor, attachment.batch_id, note);
      amendedBatchId = attachment.batch_id;
    }
    return {
      ok: true,
      partId: params.partId,
      serial: price.serial,
      fromCents: price.effectiveCents,
      toCents,
      amendedBatchId,
    };
  });
  return run();
}
