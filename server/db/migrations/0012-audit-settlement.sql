-- 0012: audit settlement of a Reserved part's attachment (ticket 14, hole 2).
--
-- When an audit closes with no grace, a due-but-unscanned Reserved part
-- becomes Unavailable. Its device_parts attachment must be settled in the
-- same transaction — ended with the truthful record of WHERE the part went
-- (Unavailable) and WHY (the audit) — so the batch's device keeps its
-- history and the next swap reports "already removed" instead of a misleading
-- race error.
--
-- The 0005 CHECKs admitted only removed_to IN ('available','rma',
-- 'damaged_by_tech') and removal_reason IN ('removal','swap'). Recording an
-- audit settlement under one of those values would falsify the immutable
-- removal record, so this migration rebuilds the table with the extended
-- CHECKs. Portable SQL throughout (ADR-0001).

CREATE TABLE device_parts_rebuilt (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
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
DROP TABLE device_parts;
ALTER TABLE device_parts_rebuilt RENAME TO device_parts;
CREATE INDEX device_parts_device ON device_parts (device_id);
CREATE INDEX device_parts_part ON device_parts (part_id);
CREATE UNIQUE INDEX device_parts_active_part ON device_parts (part_id) WHERE removed_at IS NULL;
