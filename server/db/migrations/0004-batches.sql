-- 0004: batches and devices (ticket 04) — the batch record as it replaces
-- the triage spreadsheet, WITHOUT parts (parts arrive in ticket 05; the
-- devices table leaves clean seams for them: no parts/cost/approval columns).

-- The maintained, tech-extendible Model list (CONTEXT.md: drives compatible
-- part-SKU suggestions later). Created rows are never edited away.
CREATE TABLE device_models (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id)
);

-- A Batch: group of devices repaired together. The human-facing number is
-- sequential and system-assigned (displayed "#29"-style). There is NO status
-- column on purpose: a batch's state is DERIVED from its devices' Repair
-- Statuses, never stored as a second hand-edited status.
CREATE TABLE batches (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id)
);

-- A Device row: the spreadsheet columns. At least one of imei / asset_id /
-- serial_number must be non-null (enforced in the domain, since duplicates
-- are allowed with only a warning). Portable SQL only, per ADR-0001.
CREATE TABLE devices (
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
      'Repaired', 'Unrepairable', 'Additional issues present'
    )),
  resolution_notes TEXT,
  assigned_tech_id INTEGER NOT NULL REFERENCES users(id),
  triage_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX devices_batch ON devices (batch_id);
CREATE INDEX devices_model ON devices (model_id);
CREATE INDEX devices_assigned_tech ON devices (assigned_tech_id);
CREATE INDEX devices_imei ON devices (imei);
CREATE INDEX devices_asset_id ON devices (asset_id);
CREATE INDEX devices_serial_number ON devices (serial_number);
