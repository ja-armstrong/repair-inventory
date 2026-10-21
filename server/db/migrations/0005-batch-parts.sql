-- 0005: parts on batches (ticket 05) — reservation, Need to Order demand,
-- same-SKU swaps, removals, and consumable usage.
--
-- Parts Cost is COMPUTED (SUM over the rows below) and never stored as a
-- hand-entered column, per spec story 37. `device_parts.price_cents` is the
-- SKU price snapshotted at reservation time so a device's cost stays stable
-- even if the catalog price drifts (ticket 06's approval signs off a number
-- that will not move underneath it).
--
-- The devices table from 0004 is untouched: attachment lives here, keyed to
-- device + part.

-- A serialized part attached to a device row (a Batch's part). A row with
-- removed_at IS NULL is an ACTIVE attachment; the partial unique index below
-- enforces "a part is attached to at most one device at a time" (supported by
-- both SQLite and Postgres). Removal is all-or-nothing: whoever removes
-- records WHEN (removed_at), WHO (removed_by), WHERE the part went
-- (removed_to: Available / RMA / Damaged by Tech), WHY (removal_note —
-- required), and the KIND of removal. Never a silent return to stock.
CREATE TABLE device_parts (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts(id),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  added_at TEXT NOT NULL,
  added_by INTEGER NOT NULL REFERENCES users(id),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  removed_to TEXT CHECK (removed_to IN ('available', 'rma', 'damaged_by_tech')),
  removal_note TEXT,
  removal_reason TEXT CHECK (removal_reason IN ('removal', 'swap')),
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
CREATE INDEX device_parts_device ON device_parts (device_id);
CREATE INDEX device_parts_part ON device_parts (part_id);
CREATE UNIQUE INDEX device_parts_active_part ON device_parts (part_id) WHERE removed_at IS NULL;

-- Consumable usage: quantity per device at a snapshotted unit price
-- (consumables are cost-only — never counted or audited, per CONTEXT.md).
CREATE TABLE device_consumables (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  recorded_at TEXT NOT NULL,
  recorded_by INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX device_consumables_device ON device_consumables (device_id);
CREATE INDEX device_consumables_sku ON device_consumables (sku_id);

-- Need to Order: a demand record for a SKU with insufficient Available
-- stock, tied to the Batch that needs it, with an optional supplier link
-- (CONTEXT.md: not a physical part and not a part status).
-- Ticket 07 (purchase orders) receives POs against these: receipt
-- auto-reserves received parts to the originating Batch and flips the
-- record to fulfilled (fulfilled_at / fulfilled_by; a link to the PO line
-- can be added there additively).
CREATE TABLE demand_records (
  id INTEGER PRIMARY KEY,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  device_id INTEGER REFERENCES devices(id),
  supplier TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled')),
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  fulfilled_at TEXT,
  fulfilled_by INTEGER REFERENCES users(id)
);
CREATE INDEX demand_records_batch ON demand_records (batch_id);
CREATE INDEX demand_records_sku ON demand_records (sku_id);
CREATE INDEX demand_records_open ON demand_records (status);
