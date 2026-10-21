-- 0010: batch lifecycle (ticket 06) — approval, close, and retriage.
--
-- CONTEXT.md's Batch lifecycle: Awaiting approval → Open → Closed. The
-- device-level Repair Status stays DERIVED-from/validated-against the graph
-- in batches/statuses.ts; the BATCH lifecycle is approval state, which no
-- device status can express, so it is stored — but only ever written by the
-- batches domain's own lifecycle functions (approve / close), never by hand
-- and never from another domain's write path.
--
-- approved_cost_cents is the manager's signed-off Parts Cost total at
-- approval (cost sign-off, spec story 35). Parts Cost itself stays COMPUTED
-- from the snapshotted device_parts/device_consumables rows (migration 0005);
-- this column records the number that was approved, amended when a manager
-- changes parts in place afterwards.

ALTER TABLE batches ADD COLUMN status TEXT NOT NULL DEFAULT 'Awaiting approval'
  CHECK (status IN ('Awaiting approval', 'Open', 'Closed'));
ALTER TABLE batches ADD COLUMN approved_at TEXT;
ALTER TABLE batches ADD COLUMN approved_by INTEGER REFERENCES users(id);
ALTER TABLE batches ADD COLUMN approved_cost_cents INTEGER;
ALTER TABLE batches ADD COLUMN closed_at TEXT;
ALTER TABLE batches ADD COLUMN closed_by INTEGER REFERENCES users(id);

-- Retriage lineage: a device row retriaged onto a new Batch points at the
-- row it continues ("Additional issues present" ends a device's run on its
-- Batch; the carried parts move to the new row — see batchparts' attachment
-- move). Together with the identifier columns above, this is what the
-- cross-batch device history matches on.
ALTER TABLE devices ADD COLUMN prior_device_id INTEGER REFERENCES devices(id);
CREATE INDEX devices_prior ON devices (prior_device_id);
