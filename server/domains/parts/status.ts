import type Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import { recordEvent } from "../auth/events.js";

/**
 * The part-status module (ticket 14): the ONE owner of the Serialized Part
 * status vocabulary, the guarded transition rules, and the
 * `part.status_changed` event recording. Every writer of
 * `serialized_parts.status` routes through this module:
 *
 * - the parts domain's bare status endpoint (a human's ad-hoc change),
 * - batchparts' reserve / swap / remove and the batch-close settlement (via
 *   the guarded primitives — reservations are batch-driven and carry their
 *   own richer events, and the close settlement's Reserved→Buyback /
 *   Unavailable / Available flips name their close reason in the event),
 * - order scans (RMA, buyback, return — a part joins an open shipment and
 *   becomes In-Transit, ticket 29),
 * - RMA complete (an in-transit order settles its parts Unavailable),
 * - buyback complete (an in-transit buyback order settles its parts
 *   Unavailable for ONE hand-entered order value, ticket 27 — the revenue
 *   mirror; no per-part dispositions),
 * - return complete (an in-transit return order settles its parts
 *   Unavailable with their snapshotted revenue prices, ticket 29),
 * - audit close (no-grace failure) and the scan-wins restoration in
 *   audits/counting.ts.
 *
 * Rules, each with its WHY:
 * - "A part becomes Reserved only through a Batch" (CONTEXT.md: Reserved):
 *   no caller of `changePartStatus` may set it; reservations go through
 *   `reservePart`, which batchparts always pairs with a device_parts
 *   attachment inside one transaction.
 * - A part that is Reserved belongs to its Batch: the bare endpoint refuses
 *   to move it (release it there instead).
 * - **In-Transit** (ticket 29): a part attached to an OPEN outbound order —
 *   RMA, buyback, or return — carries the `in_transit` status. The order's
 *   scan puts it there (from Available/RMA/Buyback) and the order's Complete
 *   settles it Unavailable; nothing else may touch it. The bare endpoint
 *   refuses both any change to a part attached to an in-transit order and
 *   any change to a part whose status is in_transit while no open order
 *   claims it — that pairing is an inconsistency and fails loudly. Without
 *   these rules the bare endpoint could flip a committed part to Available
 *   while the order still ships it (review finding S2a).
 * - **Buyback** (CONTEXT.md) is entered only for **Buybackable** SKUs: the
 *   buyback pool is the supplier program's intake list, and a part of a SKU
 *   the program does not take would sit there forever. The bare endpoint
 *   refuses setting buyback on a non-buybackable SKU.
 * - Transitions are guarded: the UPDATE matches the status that was just
 *   rule-checked, so an unexpected mid-write state fails loudly instead of
 *   silently overwriting.
 */

export type PartStatus =
  | "available"
  | "reserved"
  | "unavailable"
  | "rma"
  | "damaged_by_tech"
  | "buyback"
  | "in_transit";

export const PART_STATUS_LABELS: Record<PartStatus, string> = {
  available: "Available",
  reserved: "Reserved",
  unavailable: "Unavailable",
  rma: "RMA",
  damaged_by_tech: "Damaged by Tech",
  buyback: "Buyback",
  in_transit: "In-Transit",
};

/** The single label lookup — loud on an unknown status instead of a silent `?? raw` fallback. */
export function partStatusLabel(status: string): string {
  const label = PART_STATUS_LABELS[status as PartStatus];
  if (label === undefined) {
    throw new Error(`unknown part status: ${status}`);
  }
  return label;
}

export function isPartStatus(value: string): value is PartStatus {
  return value in PART_STATUS_LABELS;
}

interface PartStatusRow {
  id: number;
  serial: string;
  status: string;
  sku_name: string;
  buybackable: number;
}

function getPartStatusRow(db: Database.Database, partId: number): PartStatusRow | undefined {
  return db
    .prepare(
      `SELECT p.id, p.serial, p.status, s.name AS sku_name, s.buybackable
         FROM serialized_parts p JOIN skus s ON s.id = p.sku_id
        WHERE p.id = ?`
    )
    .get(partId) as PartStatusRow | undefined;
}

/**
 * The open (in-transit) outbound order a part is attached to, if any — one
 * definition across all three shipment kinds (RMA, buyback, return). The
 * ticket-29 union: a part on an open order is physically gone with it, and
 * the shipment owns its parts until Complete, whatever the shipment earns.
 */
export type OutboundOrderKind = "rma" | "buyback" | "return";

export interface OpenInTransitOrder {
  kind: OutboundOrderKind;
  id: number;
  number: number;
}

const OUTBOUND_ORDER_LABELS: Record<OutboundOrderKind, string> = {
  rma: "RMA order",
  buyback: "buyback order",
  return: "return order",
};

export function outboundOrderLabel(kind: OutboundOrderKind): string {
  return OUTBOUND_ORDER_LABELS[kind];
}

export function openInTransitOrder(
  db: Database.Database,
  partId: number
): OpenInTransitOrder | undefined {
  return db
    .prepare(
      `         SELECT 'rma' AS kind, o.id, o.number
          FROM rma_order_parts rp JOIN rma_orders o ON o.id = rp.rma_order_id
         WHERE rp.part_id = ? AND o.status = 'in_transit'
         UNION ALL
         SELECT 'buyback' AS kind, o.id, o.number
          FROM buyback_order_parts bp JOIN buyback_orders o ON o.id = bp.buyback_order_id
         WHERE bp.part_id = ? AND o.status = 'in_transit'
         UNION ALL
         SELECT 'return' AS kind, o.id, o.number
          FROM return_order_parts tp JOIN return_orders o ON o.id = tp.return_order_id
         WHERE tp.part_id = ? AND o.status = 'in_transit'`
    )
    .get(partId, partId, partId) as OpenInTransitOrder | undefined;
}

// ---- the guarded primitives (the only writers of serialized_parts.status) --

/**
 * The atomicity guard for reservations: a unit only becomes Reserved if it
 * is Available at the moment of the UPDATE. Returns false when another
 * writer got there first — the caller's transaction rolls back, so no
 * partial state survives. batchparts always pairs this with the
 * device_parts attachment row inside one transaction.
 */
export function reservePart(db: Database.Database, partId: number): boolean {
  return (
    db
      .prepare(
        "UPDATE serialized_parts SET status = 'reserved' WHERE id = ? AND status = 'available'"
      )
      .run(partId).changes === 1
  );
}

/**
 * The one wording of the buyback-entry rule (CONTEXT.md: Buybackable): a
 * part of a SKU the supplier's program does not take would sit in the pool
 * forever, so only Buybackable SKUs may enter it.
 */
function notBuybackableMessage(skuName: string): string {
  return `${skuName} is not buybackable — only buybackable SKUs can enter the buyback pool`;
}

/** Same guarded shape for leaving Reserved (removal / swap destinations / batch settlement). */
export function movePartFromReserved(
  db: Database.Database,
  partId: number,
  to: string
): boolean {
  if (to === "buyback") {
    // The buyback-entry rule is enforced HERE, at the one seam every
    // Reserved-leaving writer shares (removals, swaps, close settlement), so
    // no caller can bypass the guard the bare endpoint enforces. A caller
    // that asks for it is a bug, not a race — throw loudly instead of
    // returning the race signal `false`.
    const part = db
      .prepare(
        `SELECT p.serial, s.name AS sku_name, s.buybackable
           FROM serialized_parts p JOIN skus s ON s.id = p.sku_id
          WHERE p.id = ?`
      )
      .get(partId) as { serial: string; sku_name: string; buybackable: number } | undefined;
    if (part && !part.buybackable) {
      throw new Error(
        `part ${part.serial} (${part.sku_name}): ${notBuybackableMessage(part.sku_name)}`
      );
    }
  }
  return (
    db
      .prepare("UPDATE serialized_parts SET status = ? WHERE id = ? AND status = 'reserved'")
      .run(to, partId).changes === 1
  );
}

// ---- the guarded, rule-checked, event-recording transition ------------------

/**
 * Which door the change came through. The bare endpoint is a human's ad-hoc
 * change and carries the strictest rules; the system paths (order scan,
 * order complete, audit close, scan-wins) each own their transitions and
 * pass the guard that matches their window of legitimacy.
 */
export type StatusChangeVia =
  | "part_endpoint"
  | "order_scan"
  | "rma_complete"
  | "buyback_complete"
  | "return_complete"
  | "audit_close"
  | "scan_wins";

export interface StatusChangeFailure {
  ok: false;
  http: number;
  message: string;
}

export type StatusChangeResult =
  | {
      ok: true;
      partId: number;
      serial: string;
      from: PartStatus;
      to: PartStatus;
    }
  | StatusChangeFailure;

export interface ChangePartStatusParams {
  partId: number;
  to: PartStatus;
  /** Every status change carries a reason (CONTEXT.md: Note). */
  note: string;
  via: StatusChangeVia;
  /**
   * The status the caller believes the part has. The UPDATE is guarded on
   * it; a mismatch is an inconsistency (a raced or misused caller) and fails
   * loudly, rolling the caller's transaction back.
   */
  expectedFrom?: PartStatus;
  /** Extra payload fields for the part.status_changed event (RMA disposition, etc.). */
  payload?: Record<string, unknown>;
}

/**
 * One guarded, rule-checked, event-recording status change. Transaction-
 * composable (callers may run inside their own transaction; better-sqlite3
 * nests via savepoints). Returns a failure object for request-level refusals;
 * THROWS on inconsistency (unknown target status, guard mismatch) — those are
 * programming errors, not request variants.
 */
export function changePartStatus(
  db: Database.Database,
  clock: Clock,
  actor: { id: number },
  params: ChangePartStatusParams
): StatusChangeResult {
  const { to } = params;
  if (!isPartStatus(to)) {
    throw new Error(`unknown part status: ${String(to)}`);
  }
  if (params.expectedFrom !== undefined && !isPartStatus(params.expectedFrom)) {
    throw new Error(`unknown part status: ${String(params.expectedFrom)}`);
  }
  const part = getPartStatusRow(db, params.partId);
  if (!part) {
    return { ok: false, http: 404, message: `no serialized part with id ${params.partId}` };
  }
  const from = part.status as PartStatus;
  if (params.expectedFrom !== undefined && part.status !== params.expectedFrom) {
    throw new Error(
      `part ${part.serial} is ${part.status}, expected ${params.expectedFrom} — refusing the guarded status change`
    );
  }
  if (to === "reserved") {
    return {
      ok: false,
      http: 400,
      message: "a part becomes Reserved only through a Batch — reserve it from the batch that needs it",
    };
  }
  if (params.via === "part_endpoint") {
    // A Reserved part belongs to its Batch; its status changes there, not here.
    if (part.status === "reserved") {
      return {
        ok: false,
        http: 409,
        message: `${part.serial} is Reserved for a Batch — its status belongs to that Batch; release it there instead of changing it here`,
      };
    }
    // In-Transit belongs to an order's scan — the bare door cannot put a
    // part on a shipment it names nowhere.
    if (to === "in_transit") {
      return {
        ok: false,
        http: 400,
        message: `a part becomes In-Transit only by being scanned onto an RMA, buyback, or return order — not here`,
      };
    }
    // The in-transit order — RMA, buyback, or return (ticket 29) — owns
    // the part's status until it completes.
    const openOrder = openInTransitOrder(db, part.id);
    if (openOrder) {
      return {
        ok: false,
        http: 409,
        message: `${part.serial} is attached to in-transit ${outboundOrderLabel(openOrder.kind)} #${openOrder.number} — completing that order settles its status; it cannot be changed here`,
      };
    }
    // An In-Transit part no open order claims is an inconsistency: the
    // status and the order tables disagree (AGENTS.md — fail loudly).
    if (part.status === "in_transit") {
      throw new Error(
        `part ${part.serial} is in_transit but attached to no open order — the status and the order tables disagree`
      );
    }
    // Buyback is entered only for Buybackable SKUs (CONTEXT.md: Buybackable)
    // — a part the supplier's program does not take would sit in the pool
    // forever. The same rule is enforced in `movePartFromReserved` for the
    // system paths; the wording lives in one helper so it cannot drift.
    if (to === "buyback" && !part.buybackable) {
      return {
        ok: false,
        http: 409,
        message: notBuybackableMessage(part.sku_name),
      };
    }
  }
  // One transactional unit: the guarded flip and its event. Safe to call
  // inside a caller's transaction (better-sqlite3 nests via savepoints).
  const apply = db.transaction((): void => {
    const changed = db
      .prepare("UPDATE serialized_parts SET status = ? WHERE id = ? AND status = ?")
      .run(to, part.id, part.status).changes;
    if (changed !== 1) {
      throw new Error(
        `part ${part.serial} no longer has status ${part.status} — refusing the unguarded status change`
      );
    }
    recordEvent(db, clock, {
      entityType: "part",
      entityId: part.id,
      actorId: actor.id,
      action: "part.status_changed",
      payload: {
        from: part.status,
        to,
        note: params.note,
        ...(params.payload ?? {}),
      },
    });
  });
  apply();
  return { ok: true, partId: part.id, serial: part.serial, from, to };
}
