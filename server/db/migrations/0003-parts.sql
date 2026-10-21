-- 0003: the parts catalog (SKUs), serialized parts, and app settings.
--
-- SKUs carry a price stored as integer cents (decimal-safe: dollars are
-- formatted only at the API edges). `price_updated_at` is the date the price
-- was last set or refreshed; a SKU goes stale once it is older than the
-- `price_expiry_days` setting.
--
-- Serialized parts are physical units of a serialized SKU with a
-- system-assigned short unique serial (P + zero-padded id, e.g. P00001) and
-- a lifecycle status. `last_counted_at` is refreshed by cycle counts (ticket
-- 10); part status changes are events on the shared timeline.

CREATE TABLE skus (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('serialized', 'consumable')),
  created_at TEXT NOT NULL,
  price_updated_at TEXT NOT NULL
);

CREATE TABLE serialized_parts (
  id INTEGER PRIMARY KEY,
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  serial TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('available', 'reserved', 'unavailable', 'rma', 'damaged_by_tech')),
  last_counted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX serialized_parts_sku ON serialized_parts (sku_id);

-- Manager-editable key/value app settings. Seeded with the spec defaults:
-- prices expire after 90 days; full audits run every 2 months (ticket 10
-- reads audit_interval_months without adding a settings migration).
CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL
);

INSERT INTO app_settings (key, value) VALUES ('price_expiry_days', '90');
INSERT INTO app_settings (key, value) VALUES ('audit_interval_months', '2');
