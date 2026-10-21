-- 0007: RMA orders (ticket 09) — shipments of RMA-status parts back to a
-- vendor. Lifecycle: In-Transit → Complete (a created order is In-Transit;
-- there is no approval gate). On Complete every part on the order becomes
-- Unavailable — credited or RMA-rejected alike — with the per-part
-- disposition and credit value captured here for the recovery report
-- (ticket 12 sums credit_cents over completed_at intervals).
--
-- Credits are integer cents (decimal-safe, per ADR-0001); dollars exist only
-- at the API edges. Dispositions are settled only by the Complete flow, so
-- the settlement columns are NULL while the order is open.

CREATE TABLE rma_orders (
  id INTEGER PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('in_transit', 'complete')),
  created_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  completed_at TEXT
);

-- One row per part scanned onto an order. A part can sit on only one OPEN
-- order at a time (enforced in the domain inside the scan transaction);
-- the settled row stays forever as the recovery record.
CREATE TABLE rma_order_parts (
  id INTEGER PRIMARY KEY,
  rma_order_id INTEGER NOT NULL REFERENCES rma_orders(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts(id),
  added_at TEXT NOT NULL,
  added_by INTEGER NOT NULL REFERENCES users(id),
  disposition TEXT
    CHECK (disposition IS NULL OR disposition IN ('credited', 'rejected')),
  credit_cents INTEGER CHECK (credit_cents IS NULL OR credit_cents >= 0),
  disposition_note TEXT,
  settled_at TEXT,
  CHECK (
    disposition IS NULL
    OR (
      disposition_note IS NOT NULL
      AND (disposition = 'rejected' OR credit_cents IS NOT NULL)
    )
  )
);
CREATE INDEX rma_order_parts_order ON rma_order_parts (rma_order_id);
CREATE INDEX rma_order_parts_part ON rma_order_parts (part_id);

-- The recovery report's interval scan.
CREATE INDEX rma_orders_completed ON rma_orders (completed_at);
