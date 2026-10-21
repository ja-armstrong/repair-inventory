-- 0009: PO labels and scan-to-receive (ticket 08).
--
-- Expected serials are claimed before receipt so label sheets can print
-- Code 128 barcodes; the physical part row is created only on scan
-- (Available). `serial_id_claims` is the parts-domain allocation registry
-- so ad-hoc intake and PO pre-assignment cannot collide on the same
-- P##### id. Portable SQL only, per ADR-0001.

-- Claimed serial ids that are not yet rows in serialized_parts (PO
-- expected units waiting to be scanned in). nextPartId reads this table.
CREATE TABLE serial_id_claims (
  id INTEGER PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL
);

ALTER TABLE purchase_order_lines ADD COLUMN received_quantity INTEGER NOT NULL DEFAULT 0
  CHECK (received_quantity >= 0);

ALTER TABLE purchase_orders ADD COLUMN closed_at TEXT;
ALTER TABLE purchase_orders ADD COLUMN closed_by INTEGER REFERENCES users(id);
ALTER TABLE purchase_orders ADD COLUMN closed_note TEXT;

-- One row per expected physical unit on a PO line. `id` equals the future
-- serialized_parts.id (and serial_id_claims.id) so the barcode is stable
-- from print through receive. `part_id` is set when the scan creates the part.
CREATE TABLE purchase_order_expected_serials (
  id INTEGER PRIMARY KEY,
  line_id INTEGER NOT NULL REFERENCES purchase_order_lines(id),
  serial TEXT NOT NULL UNIQUE,
  part_id INTEGER REFERENCES serialized_parts(id),
  received_at TEXT,
  received_by INTEGER REFERENCES users(id),
  CHECK (
    (part_id IS NULL AND received_at IS NULL AND received_by IS NULL)
    OR (part_id IS NOT NULL AND received_at IS NOT NULL AND received_by IS NOT NULL)
  )
);
CREATE INDEX purchase_order_expected_serials_line ON purchase_order_expected_serials (line_id);
CREATE INDEX purchase_order_expected_serials_serial ON purchase_order_expected_serials (serial);

-- Label stock, stored in SIXTEENTHS of an inch: Dymo stock is fractional-inch
-- (2-5/16" has no whole-number form), and the settings endpoint validates
-- whole numbers — sixteenths keep that contract intact. Current stock is
-- 2-5/16" × 4" (37 × 64); the shop plans 2" × 1" (32 × 16). Managers edit
-- these keys like any other setting; the print view derives CSS inches.
INSERT INTO app_settings (key, value) VALUES ('label_width_sixteenths', '37');
INSERT INTO app_settings (key, value) VALUES ('label_height_sixteenths', '64');
