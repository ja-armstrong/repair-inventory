-- 0021: consumable usage removal (cost correction).
--
-- A consumable usage row is SOFT-removed: the correction is recorded ON the
-- row (when, who, why — a note is required by the domain, like every part
-- removal) and in the immutable timeline (device.consumable_removed), never
-- deleted. Parts Cost and the expense report sum only ACTIVE usage
-- (removed_at IS NULL), so a removal moves the cost forward and every past
-- record stays auditable.
--
-- SQLite cannot ADD a CHECK constraint via ALTER TABLE, so the
-- all-or-nothing rule (all removal fields set together) is enforced in the
-- domain: the one removal core writes all three or none.
ALTER TABLE device_consumables ADD COLUMN removed_at TEXT;
ALTER TABLE device_consumables ADD COLUMN removed_by INTEGER REFERENCES users(id);
ALTER TABLE device_consumables ADD COLUMN removal_note TEXT;
