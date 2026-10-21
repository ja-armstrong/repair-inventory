/**
 * The one merged note-and-event timeline (ticket 14): one component, one
 * event shape — { id, at, action, actor: {id, email} | null, entityType,
 * entityId, payload } — consumed everywhere a timeline appears (SKU detail,
 * part detail, audits, batches, POs, RMA orders). Typed notes and system
 * events render side by side, per CONTEXT.md's Note definition; the
 * description vocabulary below covers every domain's timeline actions.
 */
export interface TimelineEntry {
  id: number;
  at: string;
  action: string;
  actor: { id: number; email: string } | null;
  entityType?: string;
  entityId?: number;
  payload: Record<string, unknown> | null;
}

function formatCents(value: unknown): string {
  return `$${(Number(value ?? 0) / 100).toFixed(2)}`;
}

const ACTION_LABELS: Record<string, string> = {
  "sku.created": "SKU created",
  "sku.renamed": "Renamed",
  "sku.price_changed": "Price changed",
  "sku.price_refreshed": "Price refreshed",
  "part.added": "Added to stock",
  "part.counted": "Cycle counted",
  "part.reserved": "Reserved for a batch",
  "part.removed": "Removed from a batch",
  "part.transferred": "Part carried over",
  "demand.created": "Need to Order created",
  "demand.cancelled": "Need to Order cancelled",
  "setting.updated": "Setting updated",
};

// The part-status vocabulary, humanized (mirrors the server's
// PART_STATUS_LABELS) so part.status_changed reads "Available → In-Transit",
// not the raw snake_case.
const PART_STATUS_LABELS: Record<string, string> = {
  available: "Available",
  reserved: "Reserved",
  unavailable: "Unavailable",
  rma: "RMA",
  damaged_by_tech: "Damaged by Tech",
  buyback: "Buyback",
  in_transit: "In-Transit",
};

function statusLabel(value: unknown): string {
  const raw = String(value ?? "");
  return PART_STATUS_LABELS[raw] ?? raw;
}

function labelFor(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/**
 * Humanizes old→new values and note text out of an event payload when an
 * action has no dedicated description below.
 */
function describePayload(payload: Record<string, unknown>): string {
  const bits: string[] = [];
  if ("from" in payload && "to" in payload) {
    bits.push(`from ${String(payload.from)} to ${String(payload.to)}`);
  }
  const note = payload.note;
  if (typeof note === "string" && note.length > 0) {
    bits.push(`— ${note}`);
  }
  return bits.join(" ");
}

/** One description per timeline action across all domains. */
function describe(entry: TimelineEntry): string {
  const payload = entry.payload ?? {};
  switch (entry.action) {
    case "note.added":
      return `— ${String(payload.text ?? "")}`;
    // ---- batches & devices ----
    case "batch.created":
      return `created batch #${String(payload.number ?? "")}`;
    case "batch.approved":
      return `approved the batch's parts cost (${formatCents(payload.total)})`;
    case "batch.approval_amended":
      return `amended the approval: ${formatCents(payload.previousTotalCents)} → ${formatCents(
        payload.totalCents,
      )} — ${String(payload.note ?? "")}`;
    case "batch.closed":
      return `closed the batch (${Array.isArray(payload.settled) ? payload.settled.length : 0} installed part(s) → Unavailable)`;
    case "device.created":
      return `added device ${String(payload.model ?? "")}`;
    case "device.edited": {
      const fields = payload.fields as Record<string, { from: unknown; to: unknown }> | undefined;
      const names = Object.entries(fields ?? {})
        .map(([field, change]) => `${field}: ${String(change.from ?? "∅")} → ${String(change.to ?? "∅")}`)
        .join(", ");
      return `edited device (${names})`;
    }
    case "device.status_changed":
      // The reason distinguishes an AUTOMATIC move (the demand auto-moves:
      // "need to order" in, "need fulfilled" out) from a human's hand-set
      // transition, which carries no reason.
      return `moved device from ${String(payload.from)} to ${String(payload.to)}${
        payload.reason ? ` (${String(payload.reason)})` : ""
      }`;
    case "device.retriaged":
      return `retriaged this device onto batch #${String(payload.toBatchNumber)} (${
        Number(payload.carriedParts) || 0
      } part(s) carried over)`;
    case "device.retriaged_in":
      return `continued from batch #${String(payload.fromBatchNumber)} (device #${String(
        payload.fromDeviceId,
      )})`;
    case "part.transferred":
      return `part ${String(payload.serial ?? "")} carried over to batch #${String(
        payload.toBatchNumber ?? "",
      )} (retriage)`;
    case "part.status_changed":
      return `part${payload.serial ? ` ${String(payload.serial)}` : ""}: ${statusLabel(
        payload.from,
      )} → ${statusLabel(payload.to)}${payload.reason ? ` (${String(payload.reason)})` : ""}`;
    case "device.part_reserved":
      return `reserved part ${String(payload.serial ?? "")} (${String(payload.sku ?? "")}) on this device`;
    case "device.part_removed":
      return `removed part ${String(payload.serial ?? "")} → ${String(payload.destination ?? "")}`;
    case "device.part_swapped":
      return `swapped part ${String(payload.from ?? "")} for ${String(payload.to ?? "")} (old → ${String(payload.destination ?? "")})`;
    case "device.consumable_used":
      return `used ${String(payload.quantity ?? "")} × ${String(payload.sku ?? "")}`;
    case "device.demand_created":
      return `filed a Need to Order for ${String(payload.sku ?? "")}${
        payload.supplier ? ` (supplier: ${String(payload.supplier)})` : ""
      }`;
    case "device.demand_cancelled":
      return `cancelled a Need to Order for ${String(payload.sku ?? "")}${
        payload.note ? ` — ${String(payload.note)}` : ""
      }`;
    case "device.removed":
      return `removed this device from the batch — ${Number(payload.returnedParts) || 0} part(s) → Available, ${
        Number(payload.cancelledDemand) || 0
      } Need to Order cancelled${payload.note ? ` — ${String(payload.note)}` : ""}`;
    // ---- purchase orders ----
    case "po.created":
      return `created PO #${String(payload.number ?? "")} (${String(payload.lineCount ?? "")} line${
        Number(payload.lineCount ?? 0) === 1 ? "" : "s"
      }, ${formatCents(payload.totalCents)})`;
    case "po.status_changed":
      // The note is optional (the approval itself is the record) — the
      // dash only renders when a note was actually given.
      return `moved PO from ${String(payload.from ?? "")} to ${String(payload.to ?? "")}${
        payload.note ? ` — ${String(payload.note)}` : ""
      }`;
    case "po.tracking_added":
      return `added tracking ${String(payload.carrier ?? "")} ${String(
        payload.trackingNumber ?? "",
      )}`;
    case "po.demand_marked": {
      const ids = Array.isArray(payload.demandIds) ? payload.demandIds.length : 0;
      return `marked ${ids} demand record${ids === 1 ? "" : "s"} ordered`;
    }
    case "po.serials_assigned":
      return `assigned ${String(payload.count ?? "")} expected serial${
        Number(payload.count ?? 0) === 1 ? "" : "s"
      } for labels`;
    case "po.part_received":
      return `received ${String(payload.serial ?? "")}${
        payload.reserved ? " (auto-reserved to demand)" : ""
      }`;
    case "po.consumable_received":
      return `received ${String(payload.quantity ?? "")} of ${String(payload.sku ?? "")}`;
    case "po.lines_changed": {
      // Pre-approval revision: the payload carries the NEW line set, the
      // previous count/total, and the demand-link diff (degraded-but-visible
      // on a malformed payload, never a crash).
      const count = Array.isArray(payload.lines) ? payload.lines.length : 0;
      const previousCount = Number(payload.previousLineCount ?? 0);
      const marked = Array.isArray(payload.demandMarked) ? payload.demandMarked.length : 0;
      const released = Array.isArray(payload.demandReleased) ? payload.demandReleased.length : 0;
      const demandBits = [
        marked > 0 ? `marked ${marked} demand record${marked === 1 ? "" : "s"} ordered` : null,
        released > 0 ? `released ${released} back to outstanding` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return (
        `revised the lines (${previousCount} → ${count} line${count === 1 ? "" : "s"}, ` +
        // LINES totals: shipping is separate and unchanged by a revision,
        // and po.created's totalCents includes it — never compare the two.
        `lines total ${formatCents(payload.previousLinesTotalCents)} → ${formatCents(payload.linesTotalCents)})` +
        `${demandBits ? ` — ${demandBits}` : ""}` +
        `${payload.note ? ` — ${String(payload.note)}` : ""}`
      );
    }
    // ---- RMA orders ----
    case "rma.created":
      return `created RMA order #${String(payload.number ?? "")}`;
    case "rma.part_added":
      return `scanned ${String(payload.serial ?? "")} onto the order`;
    case "rma.part_settled": {
      const credit =
        payload.creditCents === undefined ? "" : ` for ${formatCents(payload.creditCents)}`;
      return `settled ${String(payload.serial ?? "")} as ${
        payload.disposition === "rejected" ? "RMA-rejected" : "credited"
      }${credit} — ${String(payload.note ?? "")}`;
    }
    case "rma.status_changed":
      return `moved the order from ${String(payload.from ?? "")} to ${String(payload.to ?? "")}`;
    // ---- buyback orders (ticket 27) ----
    case "buyback.created":
      return `created buyback order #${String(payload.number ?? "")}`;
    case "buyback.part_added":
      return `scanned ${String(payload.serial ?? "")} onto the order`;
    case "buyback.settled":
      // The order-level settlement (0027). Formatted like every sibling —
      // degraded-but-visible on a malformed payload, never a crash.
      return `settled the order for ${formatCents(Number(payload.orderValueCents ?? 0))}`;
    // Legacy per-part settlement events (pre-0027). The timeline is
    // immutable, so historical orders still carry them; new orders record
    // one order-level buyback.settled instead.
    case "buyback.part_settled": {
      const sale =
        payload.salePriceCents === undefined ? "" : ` for ${formatCents(payload.salePriceCents)}`;
      return `settled ${String(payload.serial ?? "")} as ${
        payload.disposition === "rejected" ? "buyback-rejected" : "sold"
      }${sale} — ${String(payload.note ?? "")}`;
    }
    case "buyback.status_changed":
      return `moved the order from ${String(payload.from ?? "")} to ${String(payload.to ?? "")}`;
    // ---- return orders (ticket 29) ----
    case "return.created":
      return `created return order #${String(payload.number ?? "")}`;
    case "return.part_added":
      return `scanned ${String(payload.serial ?? "")} onto the order`;
    case "return.part_settled":
      return `settled ${String(payload.serial ?? "")} at ${formatCents(payload.priceCents)} revenue`;
    case "return.status_changed":
      return `moved the order from ${String(payload.from ?? "")} to ${String(payload.to ?? "")}`;
    default:
      return `${labelFor(entry.action)}${describePayload(payload) ? ` ${describePayload(payload)}` : ""}`;
  }
}

export function Timeline({ events }: { events: TimelineEntry[] }) {
  if (events.length === 0) {
    return <p className="placeholder">No history yet.</p>;
  }
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id} className="timeline-entry">
          <span className="timeline-at">{new Date(event.at).toLocaleString()}</span>{" "}
          <span className="timeline-actor">
            <strong>{event.actor ? event.actor.email : "system"}</strong>
          </span>{" "}
          <span className="timeline-action">{describe(event)}</span>
        </li>
      ))}
    </ol>
  );
}
