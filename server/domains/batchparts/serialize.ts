import type { DemandJoinRow } from "./queries.js";
import { formatCents } from "../parts/prices.js";

/**
 * Ticket 06 (spec decision 7): the DISPLAY contract for a demanded
 * (not-yet-owned) part's cost. A Need to Order demand reserves nothing, so it
 * adds no stored cost — `partsCostCents` and `approved_cost_cents` exclude it
 * (a demand is an estimate, not a signed-off cost) — but showing a bare $0
 * understates what the manager is approving in the dangerous direction. The
 * estimate therefore rides along as its OWN explicit field, never folded into
 * a cost sum: it prices the demand at the SKU's CURRENT catalog price, and
 * ticket 09's arrival amendment replaces it with the part's actual price.
 */

/**
 * The open demands' SKU-price estimate in cents. Only OPEN records count — a
 * fulfilled or cancelled demand is no longer a need, so it is not even an
 * estimate any more. The one definition every cost surface reads, so they can
 * never disagree.
 */
export function openDemandEstimateCents(rows: DemandJoinRow[]): number {
  return rows
    .filter((row) => row.status === "open")
    .reduce((sum, row) => sum + row.sku_price_cents, 0);
}

/**
 * The "estimated, not signed-off" label: `NTO — est. $30.00`. Null when there
 * is nothing outstanding, so the JSON carries no estimate noise on a device
 * with no open demand.
 */
export function ntoEstimateLabel(cents: number): string | null {
  return cents === 0 ? null : `NTO — est. $${formatCents(cents)}`;
}
