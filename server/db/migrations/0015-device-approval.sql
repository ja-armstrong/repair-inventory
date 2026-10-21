-- 0015: per-device approval decisions + the Denied Repair status (ticket 25).
--
-- While a batch is Awaiting approval, the manager decides each device
-- individually: approved or rejected (CONTEXT.md: Approval). The decision
-- lives on the device row so the batch-approval transaction can apply it;
-- re-deciding before the batch opens overwrites it (the latest decision
-- wins — the timeline keeps every decision event).
--
-- approval_decision_note is required for a rejection (it becomes the
-- Denied Repair resolution notes at batch approval) and optional for an
-- approval; nullable because an approval may carry none. The columns are
-- cleared by nothing: after the batch opens they remain as the record of
-- what was decided (the event carries the actor and time). A retriaged
-- device row starts fresh (the retriage INSERT does not copy them) — the
-- new batch runs its own approval.
--
-- Denied Repair (terminal, reachable ONLY through the approval rejection)
-- must enter devices.repair_status's CHECK, and SQLite cannot ALTER a CHECK
-- — so the table is rebuilt, in the 0012 pattern. devices is a PARENT table
-- (device_parts, device_consumables and demand_records reference it) and
-- foreign keys are enforced throughout (connection.ts), so the rebuild is a
-- full cascade, all portable SQL (ADR-0001): copy every table, drop the
-- children first, then devices, recreate, rename back — SQLite's RENAME
-- rewrites the children's REFERENCES clauses to the final name. Every
-- existing row is carried over untouched; no data is reformatted.
--
-- Numbering note: the plan said 0016 believing ticket 23 took 0015, but on
-- disk ticket 23 landed as 0014 (the next free number at its commit — see
-- that file's header). 0015 is the next free number; nothing was renumbered.

-- 1. Copy devices with the extended status vocabulary and the new columns.
--    The lineage self-reference targets this table's own name so the final
--    RENAME below rewrites it to devices(id).
CREATE TABLE devices_rebuilt (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  model_id INTEGER NOT NULL REFERENCES device_models(id),
  capacity TEXT,
  asset_id TEXT,
  imei TEXT,
  serial_number TEXT,
  stated_issue TEXT NOT NULL,
  notes TEXT,
  repair_time_minutes INTEGER CHECK (repair_time_minutes IS NULL OR repair_time_minutes >= 0),
  repair_status TEXT NOT NULL DEFAULT 'Awaiting repair'
    CHECK (repair_status IN (
      'Awaiting repair', 'In progress', 'QA', 'Parts needed',
      'Repaired', 'Unrepairable', 'Additional issues present', 'Denied Repair'
    )),
  resolution_notes TEXT,
  assigned_tech_id INTEGER NOT NULL REFERENCES users(id),
  triage_date TEXT NOT NULL,
  prior_device_id INTEGER REFERENCES devices_rebuilt(id),
  approval_decision TEXT
    CHECK (approval_decision IS NULL OR approval_decision IN ('approved', 'rejected')),
  approval_decision_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO devices_rebuilt
  (id, batch_id, model_id, capacity, asset_id, imei, serial_number,
   stated_issue, notes, repair_time_minutes, repair_status, resolution_notes,
   assigned_tech_id, triage_date, prior_device_id, created_at, updated_at)
SELECT id, batch_id, model_id, capacity, asset_id, imei, serial_number,
       stated_issue, notes, repair_time_minutes, repair_status, resolution_notes,
       assigned_tech_id, triage_date, prior_device_id, created_at, updated_at
  FROM devices;

-- 2. Copy the three child tables (current shapes: 0012's device_parts
--    CHECKs), their device reference aimed at the copy so the rename
--    rewrites it.
CREATE TABLE device_parts_rebuilt (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices_rebuilt(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts(id),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  added_at TEXT NOT NULL,
  added_by INTEGER NOT NULL REFERENCES users(id),
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  removed_to TEXT CHECK (removed_to IN ('available', 'rma', 'damaged_by_tech', 'unavailable')),
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

CREATE TABLE device_consumables_rebuilt (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices_rebuilt(id),
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  recorded_at TEXT NOT NULL,
  recorded_by INTEGER NOT NULL REFERENCES users(id)
);
INSERT INTO device_consumables_rebuilt
  (id, device_id, sku_id, quantity, unit_price_cents, recorded_at, recorded_by)
SELECT id, device_id, sku_id, quantity, unit_price_cents, recorded_at, recorded_by
  FROM device_consumables;

CREATE TABLE demand_records_rebuilt (
  id INTEGER PRIMARY KEY,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  device_id INTEGER REFERENCES devices_rebuilt(id),
  supplier TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fulfilled')),
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  fulfilled_at TEXT,
  fulfilled_by INTEGER REFERENCES users(id)
);
INSERT INTO demand_records_rebuilt
  (id, sku_id, batch_id, device_id, supplier, status, created_at, created_by,
   fulfilled_at, fulfilled_by)
SELECT id, sku_id, batch_id, device_id, supplier, status, created_at, created_by,
       fulfilled_at, fulfilled_by
  FROM demand_records;

-- 3. Drop the children first: with them gone, nothing references devices
--    and its DROP cannot violate a foreign key.
DROP TABLE device_parts;
DROP TABLE device_consumables;
DROP TABLE demand_records;
DROP TABLE devices;

-- 4. The copy becomes devices; SQLite rewrites every REFERENCES
--    devices_rebuilt clause (children and the self-reference) to devices.
ALTER TABLE devices_rebuilt RENAME TO devices;

-- 5. The children take their final names back.
ALTER TABLE device_parts_rebuilt RENAME TO device_parts;
ALTER TABLE device_consumables_rebuilt RENAME TO device_consumables;
ALTER TABLE demand_records_rebuilt RENAME TO demand_records;

-- 6. Indexes (dropped with their tables; the unique partial index that
--    keeps a part attached to at most one device comes back exactly as
--    0005/0012 defined it).
CREATE INDEX devices_batch ON devices (batch_id);
CREATE INDEX devices_model ON devices (model_id);
CREATE INDEX devices_assigned_tech ON devices (assigned_tech_id);
CREATE INDEX devices_imei ON devices (imei);
CREATE INDEX devices_asset_id ON devices (asset_id);
CREATE INDEX devices_serial_number ON devices (serial_number);
CREATE INDEX devices_prior ON devices (prior_device_id);
CREATE INDEX device_parts_device ON device_parts (device_id);
CREATE INDEX device_parts_part ON device_parts (part_id);
CREATE UNIQUE INDEX device_parts_active_part ON device_parts (part_id) WHERE removed_at IS NULL;
CREATE INDEX device_consumables_device ON device_consumables (device_id);
CREATE INDEX device_consumables_sku ON device_consumables (sku_id);
CREATE INDEX demand_records_batch ON demand_records (batch_id);
CREATE INDEX demand_records_sku ON demand_records (sku_id);
CREATE INDEX demand_records_open ON demand_records (status);
