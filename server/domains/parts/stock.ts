import type Database from "better-sqlite3";

/**
 * On-hand stock (the stock module): the ONE definition of how many units of
 * a SKU are on the shelf — the count of its serialized parts in the Available
 * status. Reserved, Unavailable, RMA, Damaged by Tech, Buyback, and
 * In-Transit units are all spoken for or out of circulation; only an
 * Available unit can serve the next need, so only those count as on hand.
 *
 * The same definition answers the Minimum On-hand rule (CONTEXT.md: SKU):
 * when a serialized SKU's `min_on_hand` is greater than zero and its on-hand
 * count is below it, the SKU is below minimum and the purchase-orders domain
 * prompts with the shortfall — `countAvailable` is the single number both
 * the SKU serialization and the below-minimum query read, so the two
 * surfaces cannot drift.
 *
 * No table-existence guards: the migration runner guarantees `skus` and
 * `serialized_parts` in any database the app opens; a missing table is a
 * broken database — the query throws and the central error handler surfaces
 * a loud 500, never a silent "no stock".
 */

/** The on-hand count for one SKU: its serialized parts in Available status. */
export function countAvailable(db: Database.Database, skuId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM serialized_parts WHERE sku_id = ? AND status = 'available'")
    .get(skuId) as { n: number };
  return row.n;
}

export interface BelowMinimumSku {
  skuId: number;
  skuName: string;
  /** How many Available units are on the shelf right now. */
  availableCount: number;
  /** The SKU's declared minimum on-hand quantity. */
  minOnHand: number;
  /** minOnHand − availableCount: the suggested PO line quantity. */
  shortfall: number;
}

/**
 * Every serialized SKU whose on-hand stock sits below its minimum on-hand
 * quantity, with the shortfall. A minimum of 0 means "no minimum" — those
 * SKUs never appear. The list is a prompt, not a state machine: it is
 * computed from live stock at read time and does not track what open POs
 * already order (unlike demand records, a minimum has no lifecycle of its
 * own — receiving stock is what makes the row disappear).
 */
export function listSkusBelowMinimum(db: Database.Database): BelowMinimumSku[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.min_on_hand,
              (SELECT COUNT(*) FROM serialized_parts p
                WHERE p.sku_id = s.id AND p.status = 'available') AS available
         FROM skus s
        WHERE s.kind = 'serialized'
          AND s.min_on_hand > 0
          AND (SELECT COUNT(*) FROM serialized_parts p
                WHERE p.sku_id = s.id AND p.status = 'available') < s.min_on_hand
        ORDER BY s.id`
    )
    .all() as Array<{ id: number; name: string; min_on_hand: number; available: number }>;
  return rows.map((row) => ({
    skuId: row.id,
    skuName: row.name,
    availableCount: row.available,
    minOnHand: row.min_on_hand,
    shortfall: row.min_on_hand - row.available,
  }));
}
