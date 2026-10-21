import type Database from "better-sqlite3";
import { listOutstandingDemand as listSharedOutstandingDemand } from "../batchparts/queries.js";

/**
 * The integration seam with ticket 05 (batch-parts): Need to Order demand
 * records live in THEIR migration (0005, `demand_records`) and domain — and
 * so does the outstanding-demand definition itself (batchparts/queries.ts,
 * final review F1 / architecture C): ONE query behind both GET /api/demand
 * and the PO form's GET /api/purchase-orders/demand, so the two endpoints
 * cannot drift. This module maps that shared query to the PO form's wire
 * shape and keeps the id validation the create route uses. It never writes
 * to `demand_records`: marking demand ordered is recorded in THIS domain's
 * `purchase_order_demand` link table (migration 0006), and the shared query
 * subtracts those ids.
 *
 * No table-existence guards (review S1 / architecture C): the migration
 * runner guarantees `demand_records` and `purchase_order_demand` in any
 * database the app opens, so a missing table is a broken database — these
 * queries throw and the central error handler surfaces a loud 500, never a
 * silent "no demand".
 */

export interface DemandSummary {
  id: number;
  skuId: number | null;
  skuName: string | null;
  quantity: number | null;
  supplier: string | null;
  /** Ticket 11: the SKU's default source link — the supplier prefill. */
  defaultSourceUrl: string | null;
  batchId: number | null;
  deviceId: number | null;
}

/**
 * Whether an OPEN Need to Order demand record with this id exists. Fulfilled
 * records are settled history; cancelled records (ticket 30) belong to a run
 * that ended — neither may be marked ordered, and neither will be auto-
 * reserved to on receipt (pickDemand serves 'open' only). A missing
 * `demand_records` table is a broken database — the query throws (loud 500),
 * it does not degrade to "cannot validate".
 */
export function openDemandExists(db: Database.Database, id: number): boolean {
  return db.prepare("SELECT 1 FROM demand_records WHERE id = ? AND status = 'open'").get(id) !== undefined;
}

/**
 * Outstanding Need to Order demand for the PO form: the one shared
 * definition (batchparts/queries.ts), mapped to this endpoint's fields.
 * Their record is unit-grain (one row per needed part) — the PO form groups
 * selected records into lines client-side.
 */
export function listOutstandingDemand(db: Database.Database): DemandSummary[] {
  return listSharedOutstandingDemand(db).map((row) => ({
    id: row.id,
    skuId: row.sku_id,
    skuName: row.sku_name,
    quantity: null,
    supplier: row.supplier,
    defaultSourceUrl: row.sku_default_source_url,
    batchId: row.batch_id,
    deviceId: row.device_id,
  }));
}

/**
 * The SAME outstanding demand, GROUPED per SKU: one row per needed part kind
 * with the total quantity — a shop ordering "5 × iPhone 13 Screen" should
 * not tick five individual records. Each group carries the underlying
 * demand ids (linking a PO line to the group marks ALL of them ordered, and
 * receipt fulfills them one per received unit) and the distinct batches
 * needing it. The first non-null supplier rides along as the line-source
 * prefill fallback — the SKU's default source link (ticket 11) is preferred
 * over it.
 */
export interface OutstandingDemandGroup {
  skuId: number;
  skuName: string;
  quantity: number;
  demandIds: number[];
  batchIds: number[];
  supplier: string | null;
  suppliers: string[];
  /**
   * Ticket 11: the SKU's default source link. The PO form's line-source
   * prefill prefers this over the demand records' own supplier (which was
   * itself prefilled from here at demand-creation time) — the SKU is where
   * "where do we buy this" lives.
   */
  defaultSourceUrl: string | null;
}

export function listOutstandingDemandGrouped(db: Database.Database): OutstandingDemandGroup[] {
  const groups = new Map<number, OutstandingDemandGroup>();
  for (const row of listSharedOutstandingDemand(db)) {
    const existing = groups.get(row.sku_id);
    if (existing) {
      existing.quantity += 1;
      existing.demandIds.push(row.id);
      if (!existing.batchIds.includes(row.batch_id)) {
        existing.batchIds.push(row.batch_id);
      }
      if (row.supplier !== null && !existing.suppliers.includes(row.supplier)) {
        existing.suppliers.push(row.supplier);
      }
    } else {
      groups.set(row.sku_id, {
        skuId: row.sku_id,
        skuName: row.sku_name,
        quantity: 1,
        demandIds: [row.id],
        batchIds: [row.batch_id],
        supplier: row.supplier,
        suppliers: row.supplier === null ? [] : [row.supplier],
        defaultSourceUrl: row.sku_default_source_url,
      });
    }
  }
  return [...groups.values()].sort((a, b) => a.skuId - b.skuId);
}
