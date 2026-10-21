-- 0006: purchase orders (ticket 07) — the paperwork half: creation,
-- manager approval (Awaiting approval -> In-transit), tracking entries,
-- and history-backed suggestions for purpose/sources. Receiving
-- (Partially received / Received, barcode labels, auto-reservation) is
-- ticket 08; the status CHECK deliberately admits those values plus
-- Closed (close-with-shortfall by note) so the status machine extends
-- without another migration. Portable SQL only, per ADR-0001.

CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,          -- sequential human number, like batches
  purpose TEXT NOT NULL,
  sources TEXT,                            -- free text; suggested from history, never a dropdown
  shipping_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (shipping_cost_cents >= 0),
  status TEXT NOT NULL DEFAULT 'Awaiting approval' CHECK (status IN (
    'Awaiting approval', 'In-transit', 'Partially received', 'Received', 'Closed'
  )),
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  approved_at TEXT,
  approved_by INTEGER REFERENCES users(id)
);
CREATE INDEX purchase_orders_status ON purchase_orders (status);

-- One line per SKU purchase: quantity and unit price (integer cents; the
-- SKU catalog's price is only the default the form offers, the recorded
-- unit price is what was actually agreed). `source` is the vendor for THIS
-- line, pre-filled from a Need to Order demand record's supplier link.
-- `demand_id` ties the line to the demand record it fulfills, if any.
CREATE TABLE purchase_order_lines (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  sku_id INTEGER NOT NULL REFERENCES skus(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 1),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  source TEXT,
  demand_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX purchase_order_lines_po ON purchase_order_lines (po_id);
CREATE INDEX purchase_order_lines_sku ON purchase_order_lines (sku_id);

-- Tracking entries (carrier + number), append-only; multiple per PO.
CREATE TABLE purchase_order_tracking (
  id INTEGER PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  carrier TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  added_at TEXT NOT NULL,
  added_by INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX purchase_order_tracking_po ON purchase_order_tracking (po_id);

-- INTEGRATION POINT (ticket 05): Need to Order demand records belong to
-- the batch-parts domain (migration 0005), and outstanding demand = their
-- table minus these ids. This table carries NO foreign key to their table —
-- a deliberate decoupling, not a stepped-database guard: the migration
-- runner applies 0005 before 0006 in every database the app opens (that
-- strict ordering is the contract, ticket 15), so the domains keep their
-- tables schema-independent and coordinate at the domain seams instead.
CREATE TABLE purchase_order_demand (
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  demand_id INTEGER NOT NULL,
  marked_at TEXT NOT NULL,
  UNIQUE (po_id, demand_id)
);
CREATE INDEX purchase_order_demand_demand ON purchase_order_demand (demand_id);
