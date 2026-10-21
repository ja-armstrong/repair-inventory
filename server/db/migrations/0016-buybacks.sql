-- 0016: buybacks (ticket 27) — a supplier sell-back flow mirroring RMA.
--
-- CONTEXT.md: **Buybackable** is a SKU flag marking its parts as eligible
-- for the buyback program; removing a Buybackable part defaults to the
-- Buyback destination. **Buyback** is a part status (slated for sale to a
-- supplier's program). **Buyback Order**: In-Transit → Complete; sold parts
-- leave inventory (Unavailable) with a recorded sale price — the revenue
-- mirror of RMA credits, captured here for the buyback-recovery report.
--
-- Four changes:
-- 1. skus.buybackable — NOT NULL DEFAULT 0 is truthful for every existing
--    row (nothing was buybackable before this ticket), so a plain ADD
--    COLUMN works portably. Serialized-only is enforced in the domain (a
--    consumable has no units to sell back).
-- 2. serialized_parts is rebuilt: the status vocabulary gains 'buyback',
--    and SQLite cannot ALTER a CHECK. serialized_parts is a PARENT table
--    (device_parts, rma_order_parts, audit_parts and
--    purchase_order_expected_serials reference it) and foreign keys stay
--    enforced throughout (connection.ts, ADR-0001), so the rebuild is the
--    full 0015 cascade pattern: copy the parent and every child, drop the
--    children first, then the parent, rename the copy back (SQLite's RENAME
--    rewrites the children's REFERENCES clauses), rename the children back,
--    recreate every index. Every row is carried over untouched.
-- 3. device_parts is rebuilt in the same pass (its copy targets the parent
--    copy) so the removal-destination CHECK admits 'buyback' — removing a
--    buybackable part to the Buyback pool must be recordable at the schema
--    level, not just the domain (the 0012 CHECK shape otherwise).
-- 4. buyback_orders / buyback_order_parts mirror 0007's RMA pair exactly,
--    with 'sold'/'rejected' dispositions and sale_price_cents in place of
--    credit_cents. Settlement columns stay NULL while the order is open.

ALTER TABLE skus
  ADD COLUMN buybackable INTEGER NOT NULL DEFAULT 0 CHECK (buybackable IN (0, 1));

-- 1. The parent copy: 0003 + 0013 (intake_source) + 0014 (price_cents)
--    columns, with 'buyback' added to the status CHECK.
CREATE TABLE serialized_parts_rebuilt (
  id INTEGER PRIMARY KEY,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  serial TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('available', 'reserved', 'unavailable', 'rma', 'damaged_by_tech', 'buyback')),
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
--    the rename below rewrites it. device_parts takes its 0012 CHECK shape
--    extended with removed_to 'buyback'.
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
DROP TABLE audit_parts;
DROP TABLE purchase_order_expected_serials;
DROP TABLE serialized_parts;

-- 4. The copy becomes serialized_parts; SQLite rewrites every REFERENCES
--    serialized_parts_rebuilt clause (the four children) to the final name.
ALTER TABLE serialized_parts_rebuilt RENAME TO serialized_parts;

-- 5. The children take their final names back.
ALTER TABLE device_parts_rebuilt RENAME TO device_parts;
ALTER TABLE rma_order_parts_rebuilt RENAME TO rma_order_parts;
ALTER TABLE audit_parts_rebuilt RENAME TO audit_parts;
ALTER TABLE purchase_order_expected_serials_rebuilt RENAME TO purchase_order_expected_serials;

-- 6. Indexes (dropped with their tables).
CREATE INDEX serialized_parts_sku ON serialized_parts (sku_id);
CREATE INDEX device_parts_device ON device_parts (device_id);
CREATE INDEX device_parts_part ON device_parts (part_id);
CREATE UNIQUE INDEX device_parts_active_part ON device_parts (part_id) WHERE removed_at IS NULL;
CREATE INDEX rma_order_parts_order ON rma_order_parts (rma_order_id);
CREATE INDEX rma_order_parts_part ON rma_order_parts (part_id);
CREATE INDEX audit_parts_part ON audit_parts (part_id);
CREATE INDEX purchase_order_expected_serials_line ON purchase_order_expected_serials (line_id);
CREATE INDEX purchase_order_expected_serials_serial ON purchase_order_expected_serials (serial);

-- 7. The buyback orders, mirroring 0007's RMA pair. One row per part
--    scanned onto an order; a part can sit on only one OPEN order at a time
--    (enforced in the domain inside the scan transaction); the settled row
--    stays forever as the revenue record. A sold part requires a sale
--    price; a buyback-rejected part records the refusal at zero.
CREATE TABLE buyback_orders (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('in_transit', 'complete')),
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  completed_at TEXT
);

CREATE TABLE buyback_order_parts (
  id INTEGER PRIMARY KEY,
  buyback_order_id INTEGER NOT NULL REFERENCES buyback_orders(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts(id),
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
CREATE INDEX buyback_order_parts_order ON buyback_order_parts (buyback_order_id);
CREATE INDEX buyback_order_parts_part ON buyback_order_parts (part_id);
CREATE INDEX buyback_orders_completed ON buyback_orders (completed_at);
