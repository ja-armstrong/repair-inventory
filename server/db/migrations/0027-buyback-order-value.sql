-- 0027: buyback order value (spec: .scratch/buyback-order-value) — a Buyback
-- Order completes with ONE hand-entered value for the whole shipment, not a
-- disposition and sale price per part. The supplier pays a lump sum; nobody
-- records which parts were accepted or what each one fetched, so the
-- per-part settlement columns were friction producing data nobody used.
--
-- Two changes:
-- 1. buyback_orders.order_value_cents — NULL while the order is open, set
--    only by the Complete flow (the recovery revenue). SQLite cannot ADD a
--    CHECK via ALTER, so the non-negative rule is domain-guaranteed at the
--    one write site (the Complete transaction's parsePriceToCents) — the
--    same pattern as migrations 0021 and 0026. Backfill: every
--    already-complete order gets the sum of its recorded per-part sale
--    prices (the old CHECK guaranteed sold rows carry a price and rejected
--    rows carry none), so the revenue record stays exactly what it was.
-- 2. buyback_order_parts is rebuilt without its settlement columns
--    (disposition, sale_price_cents, disposition_note, settled_at): it is
--    the ATTACHMENT record now — which parts shipped on which order — and
--    the order's completed_at plus order_value_cents are the settlement
--    record. Nothing references this table, so the rebuild is a copy, drop,
--    rename against the untouched parents (serialized_parts, users).

ALTER TABLE buyback_orders ADD COLUMN order_value_cents INTEGER;

-- The backfill runs BEFORE the parts rebuild, while the old settlement
-- columns still exist to sum.
UPDATE buyback_orders
   SET order_value_cents = COALESCE((
         SELECT SUM(bp.sale_price_cents)
           FROM buyback_order_parts bp
          WHERE bp.buyback_order_id = buyback_orders.id
       ), 0)
 WHERE status = 'complete';

CREATE TABLE buyback_order_parts_rebuilt (
  id INTEGER PRIMARY KEY,
  buyback_order_id INTEGER NOT NULL REFERENCES buyback_orders(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts(id),
  added_at TEXT NOT NULL,
  added_by INTEGER NOT NULL REFERENCES users(id)
);
INSERT INTO buyback_order_parts_rebuilt (id, buyback_order_id, part_id, added_at, added_by)
SELECT id, buyback_order_id, part_id, added_at, added_by
  FROM buyback_order_parts;

DROP TABLE buyback_order_parts;
ALTER TABLE buyback_order_parts_rebuilt RENAME TO buyback_order_parts;

-- Indexes (dropped with their table).
CREATE INDEX buyback_order_parts_order ON buyback_order_parts (buyback_order_id);
CREATE INDEX buyback_order_parts_part ON buyback_order_parts (part_id);
