-- 0019: device removal from batches + cancelled Need to Order demand (ticket 30).
--
-- A non-terminal device can be REMOVED from its batch by any tech (while the
-- batch is Awaiting approval or Open): the run ends without a repair outcome
-- on this batch. The row is kept — devices are matched across batches by
-- identifiers and the timeline speaks of device ids — so removal is recorded
-- on the row (removed_at / removed_by / removal_note) and every live listing
-- filters `removed_at IS NULL`. No table CHECK enforces the pairing of those
-- three (devices is a parent table and a CHECK across the new columns would
-- need the full 0015 rebuild for no extra safety: the removal endpoint is the
-- only writer and requires all three in one guarded UPDATE — the same shape
-- as approval_decision's enforcement).
--
-- Its effects are written in the same transaction: every active attachment is
-- ended with destination Available (batchparts' returnAttachmentsToStock,
-- reason device_removed) and every OPEN demand for the device becomes
-- CANCELLED — a need for a repair that will not happen on this batch. A
-- cancelled demand can no longer be marked ordered (purchaseorders checks
-- status 'open') and receipt can no longer auto-reserve onto the device
-- (pickDemand selects status 'open'); units bought for it simply land
-- Available. Demand already marked ordered keeps its purchase_order_demand
-- link — that PO genuinely bought the part; only the demand's future is
-- cancelled.
--
-- 'cancelled' must enter demand_records.status's CHECK, and SQLite cannot
-- ALTER a CHECK — so demand_records is rebuilt, in the 0015/0016 pattern.
-- demand_records is a LEAF-adjacent table here: purchase_order_demand.demand_id
-- deliberately carries NO foreign key (0006: schema-independent domains,
-- coordination at the seams), so nothing must cascade. All portable SQL
-- (ADR-0001).

-- 1. The device-removal columns (portable ADD COLUMN — nullable, no CHECK).
ALTER TABLE devices ADD COLUMN removed_at TEXT;
ALTER TABLE devices ADD COLUMN removed_by INTEGER REFERENCES users(id);
ALTER TABLE devices ADD COLUMN removal_note TEXT;

-- 2. Rebuild demand_records with 'cancelled' in the status CHECK and the
--    cancellation record columns. The pairing CHECK is CREATE-time, so the
--    full-table form is allowed (0018's return_order_parts shape).
CREATE TABLE demand_records_rebuilt (
  id INTEGER PRIMARY KEY,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  device_id INTEGER REFERENCES devices(id),
  supplier TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled', 'cancelled')),
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  fulfilled_at TEXT,
  fulfilled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
INSERT INTO demand_records_rebuilt
  (id, sku_id, batch_id, device_id, supplier, status, created_at, created_by,
   fulfilled_at, fulfilled_by)
SELECT id, sku_id, batch_id, device_id, supplier, status, created_at, created_by,
       fulfilled_at, fulfilled_by
  FROM demand_records;

DROP TABLE demand_records;
ALTER TABLE demand_records_rebuilt RENAME TO demand_records;

-- 3. Indexes (dropped with the table; the open-status index serves the
--    outstanding-demand queue and the cancel scan alike).
CREATE INDEX demand_records_batch ON demand_records (batch_id);
CREATE INDEX demand_records_sku ON demand_records (sku_id);
CREATE INDEX demand_records_open ON demand_records (status);
