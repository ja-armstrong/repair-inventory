-- 0020: per-batch device numbers (ticket 30, follow-up).
--
-- A device row on a batch gets a stable human number ("device #8 of batch
-- #12") — assigned at creation as MAX(device_number)+1 within the batch,
-- NEVER reused: removing a device from a batch (0019) leaves its number
-- behind with the row, and future devices continue past it, so references
-- in conversation and notes stay truthful.
--
-- Stored, not derived, like batches.number / purchase_orders.number: a
-- derived ordinal would renumber on removal and lie about history. (Porta-
-- bility note: NOT NULL would require the full 0015 parent rebuild; the
-- domain instead guarantees assignment at every insert — both writers — and
-- the partial UNIQUE index below makes a duplicate or absent number visible
-- on the read path.) Backfill: ordinal by id within the batch — creation
-- order, the same order every device listing already sorts by.

ALTER TABLE devices ADD COLUMN device_number INTEGER;

UPDATE devices
   SET device_number = (
         SELECT COUNT(*) FROM devices d2
          WHERE d2.batch_id = devices.batch_id AND d2.id <= devices.id
       );

CREATE UNIQUE INDEX devices_batch_number ON devices (batch_id, device_number)
  WHERE device_number IS NOT NULL;
