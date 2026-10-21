-- 0018: return orders + the In-Transit part status (ticket 29).
--
-- CONTEXT.md: a **Return Order** ships Available parts back to a vendor and
-- books each part's price as revenue when it completes — unlike an RMA
-- order, whose credit is entered by hand when the vendor accepts it, and a
-- buyback order, whose sale price is entered when the supplier accepts it.
-- While those orders are open, their estimated recovery (50% RMA, 10%
-- buyback of the parts'-price sum) is a display rule, computed server-side
-- from the parts' effective prices — never stored.
--
-- To make "physically gone with an order" true at a glance, a part attached
-- to an OPEN outbound order (RMA, buyback, or return) carries the new
-- **In-Transit** status: scanning flips Available/RMA/Buyback → in_transit;
-- completing the order flips in_transit → unavailable. Only the order
-- domains perform these transitions; the bare part endpoint refuses them.
--
-- Two changes:
-- 1. serialized_parts is rebuilt: the status vocabulary gains 'in_transit',
--    and SQLite cannot ALTER a CHECK. serialized_parts is a PARENT table
--    (device_parts, rma_order_parts, buyback_order_parts, audit_parts and
--    purchase_order_expected_serials reference it) and foreign keys stay
--    enforced throughout (connection.ts, ADR-0001), so the rebuild is the
--    full 0016 cascade pattern: copy the parent and every child, drop the
--    children first, then the parent, rename the copy back (SQLite's RENAME
--    rewrites the children's REFERENCES clauses), rename the children back,
--    recreate every index. Every row is carried over untouched.
-- 2. return_orders / return_order_parts mirror 0007's RMA pair, minus the
--    disposition columns: every part settles with a snapshotted revenue
--    price (integer cents, the part's effective price at completion). The
--    CHECK ties the snapshot to the settlement: price_cents is set exactly
--    when settled_at is.

-- 1. The parent copy: 0003 + 0013 (intake_source) + 0014 (price_cents)
--    columns, with 'in_transit' added to the status CHECK.
CREATE TABLE serialized_parts_rebuilt (
  id INTEGER PRIMARY KEY,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  serial TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('available', 'reserved', 'unavailable', 'rma', 'damaged_by_tech', 'buyback', 'in_transit')),
  last_counted_at TEXT,
  created_at TEXT NOT NULL,
  intake_source TEXT CHECK (intake_source IN ('purchase-order', 'migration', 'salvage')),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0)
);
INSERT INTO serialized_parts_rebuilt
  (id, sku_id, serial, status, last_counted_at, created_at, intake_source, price_cents)
SELECT id, sku_id, serial, status, last_counted_at, created_at, intake_source, price_cents
  FROM serialized_parts;

-- 2. The children, their serialized_parts reference aimed at the copy so
--    the rename below rewrites it. All shapes are the 0016 versions.
CREATE TABLE device_parts_rebuilt (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts_rebuilt(id),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  added_at TEXT NOT NULL,
  added_by INTEGER NOT NULL REFERENCES users(id),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  removed_to TEXT CHECK (removed_to IN ('available', 'rma', 'damaged_by_tech', 'unavailable', 'buyback')),
  removal_note TEXT,
  removal_reason TEXT CHECK (removal_reason IN ('removal', 'swap', 'audit')),
  CHECK (
    (added_at IS NOT NULL)
    AND (
      (removed_at IS NULL AND removed_by IS NULL AND removed_to IS NULL
         AND removal_note IS NULL AND removal_reason IS NULL)
      OR
      (removed_at IS NOT NULL AND removed_by IS NOT NULL AND removed_to IS NOT NULL
         AND removal_note IS NOT NULL AND removal_reason IS NOT NULL)
    )
  )
);
INSERT INTO device_parts_rebuilt
  (id, device_id, part_id, price_cents, added_at, added_by,
   removed_at, removed_by, removed_to, removal_note, removal_reason)
SELECT id, device_id, part_id, price_cents, added_at, added_by,
       removed_at, removed_by, removed_to, removal_note, removal_reason
  FROM device_parts;

CREATE TABLE rma_order_parts_rebuilt (
  id INTEGER PRIMARY KEY,
  rma_order_id INTEGER NOT NULL REFERENCES rma_orders(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts_rebuilt(id),
  added_at TEXT NOT NULL,
  added_by INTEGER NOT NULL REFERENCES users(id),
  disposition TEXT
    CHECK (disposition IS NULL OR disposition IN ('credited', 'rejected')),
  credit_cents INTEGER CHECK (credit_cents IS NULL OR credit_cents >= 0),
  disposition_note TEXT,
  settled_at TEXT,
  CHECK (
    disposition IS NULL
    OR (
      disposition_note IS NOT NULL
      AND (disposition = 'rejected' OR credit_cents IS NOT NULL)
    )
  )
);
INSERT INTO rma_order_parts_rebuilt
  (id, rma_order_id, part_id, added_at, added_by, disposition, credit_cents,
   disposition_note, settled_at)
SELECT id, rma_order_id, part_id, added_at, added_by, disposition, credit_cents,
       disposition_note, settled_at
  FROM rma_order_parts;

CREATE TABLE buyback_order_parts_rebuilt (
  id INTEGER PRIMARY KEY,
  buyback_order_id INTEGER NOT NULL REFERENCES buyback_orders(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts_rebuilt(id),
  added_at TEXT NOT NULL,
  added_by INTEGER NOT NULL REFERENCES users(id),
  disposition TEXT
    CHECK (disposition IS NULL OR disposition IN ('sold', 'rejected')),
  sale_price_cents INTEGER CHECK (sale_price_cents IS NULL OR sale_price_cents >= 0),
  disposition_note TEXT,
  settled_at TEXT,
  CHECK (
    disposition IS NULL
    OR (
      disposition_note IS NOT NULL
      AND (disposition = 'rejected' OR sale_price_cents IS NOT NULL)
    )
  )
);
INSERT INTO buyback_order_parts_rebuilt
  (id, buyback_order_id, part_id, added_at, added_by, disposition,
   sale_price_cents, disposition_note, settled_at)
SELECT id, buyback_order_id, part_id, added_at, added_by, disposition,
       sale_price_cents, disposition_note, settled_at
  FROM buyback_order_parts;

CREATE TABLE audit_parts_rebuilt (
  audit_id INTEGER NOT NULL REFERENCES audits(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts_rebuilt(id),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('counted', 'failed', 'moved')),
  PRIMARY KEY (audit_id, part_id)
);
INSERT INTO audit_parts_rebuilt (audit_id, part_id, outcome)
SELECT audit_id, part_id, outcome FROM audit_parts;

CREATE TABLE purchase_order_expected_serials_rebuilt (
  id INTEGER PRIMARY KEY,
  line_id INTEGER NOT NULL REFERENCES purchase_order_lines(id),
  serial TEXT NOT NULL UNIQUE,
  part_id INTEGER REFERENCES serialized_parts_rebuilt(id),
  received_at TEXT,
  received_by INTEGER REFERENCES users(id),
  CHECK (
    (part_id IS NULL AND received_at IS NULL AND received_by IS NULL)
    OR (part_id IS NOT NULL AND received_at IS NOT NULL AND received_by IS NOT NULL)
  )
);
INSERT INTO purchase_order_expected_serials_rebuilt
  (id, line_id, serial, part_id, received_at, received_by)
SELECT id, line_id, serial, part_id, received_at, received_by
  FROM purchase_order_expected_serials;

-- 3. Drop the children first: with them gone, nothing references
--    serialized_parts and its DROP cannot violate a foreign key.
DROP TABLE device_parts;
DROP TABLE rma_order_parts;
DROP TABLE buyback_order_parts;
DROP TABLE audit_parts;
DROP TABLE purchase_order_expected_serials;
DROP TABLE serialized_parts;

-- 4. The copy becomes serialized_parts; SQLite rewrites every REFERENCES
--    serialized_parts_rebuilt clause (the five children) to the final name.
ALTER TABLE serialized_parts_rebuilt RENAME TO serialized_parts;

-- 5. The children take their final names back.
ALTER TABLE device_parts_rebuilt RENAME TO device_parts;
ALTER TABLE rma_order_parts_rebuilt RENAME TO rma_order_parts;
ALTER TABLE buyback_order_parts_rebuilt RENAME TO buyback_order_parts;
ALTER TABLE audit_parts_rebuilt RENAME TO audit_parts;
ALTER TABLE purchase_order_expected_serials_rebuilt RENAME TO purchase_order_expected_serials;

-- 6. Indexes (dropped with their tables).
CREATE INDEX serialized_parts_sku ON serialized_parts (sku_id);
CREATE INDEX device_parts_device ON device_parts (device_id);
CREATE INDEX device_parts_part ON device_parts (part_id);
CREATE UNIQUE INDEX device_parts_active_part ON device_parts (part_id) WHERE removed_at IS NULL;
CREATE INDEX rma_order_parts_order ON rma_order_parts (rma_order_id);
CREATE INDEX rma_order_parts_part ON rma_order_parts (part_id);
CREATE INDEX buyback_order_parts_order ON buyback_order_parts (buyback_order_id);
CREATE INDEX buyback_order_parts_part ON buyback_order_parts (part_id);
CREATE INDEX audit_parts_part ON audit_parts (part_id);
CREATE INDEX purchase_order_expected_serials_line ON purchase_order_expected_serials (line_id);
CREATE INDEX purchase_order_expected_serials_serial ON purchase_order_expected_serials (serial);

-- 6b. The status backfill: a part attached to an OPEN (in-transit) RMA or
--     buyback order is physically gone with it, so it takes the new
--     In-Transit status. Invariant preserved: in_transit ⇔ attached to an
--     open outbound order.
UPDATE serialized_parts
   SET status = 'in_transit'
 WHERE status IN ('rma', 'buyback')
   AND (
        EXISTS (SELECT 1 FROM rma_order_parts rp JOIN rma_orders ro ON ro.id = rp.rma_order_id
                 WHERE rp.part_id = serialized_parts.id AND ro.status = 'in_transit')
        OR
        EXISTS (SELECT 1 FROM buyback_order_parts bp JOIN buyback_orders bo ON bo.id = bp.buyback_order_id
                 WHERE bp.part_id = serialized_parts.id AND bo.status = 'in_transit')
   );

-- 7. The return orders, mirroring 0007's RMA pair. One row per part scanned
--    onto an order; a part can sit on only one OPEN order at a time (the
--    In-Transit status itself enforces it: an in-transit part is neither
--    Available nor RMA nor Buyback, so no second order can take it). The
--    settled row is the revenue record: price_cents is the part's effective
--    price snapshotted at completion, so a later reprice cannot rewrite it.
CREATE TABLE return_orders (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('in_transit', 'complete')),
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  completed_at TEXT
);

CREATE TABLE return_order_parts (
  id INTEGER PRIMARY KEY,
  return_order_id INTEGER NOT NULL REFERENCES return_orders(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts(id),
  added_at TEXT NOT NULL,
  added_by INTEGER NOT NULL REFERENCES users(id),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  settled_at TEXT,
  CHECK ((price_cents IS NULL) = (settled_at IS NULL))
);
CREATE INDEX return_order_parts_order ON return_order_parts (return_order_id);
CREATE INDEX return_order_parts_part ON return_order_parts (part_id);
CREATE INDEX return_orders_completed ON return_orders (completed_at);
