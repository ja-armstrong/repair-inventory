-- 0028: the SKU's minimum on-hand quantity.
--
-- A serialized SKU may declare the smallest on-hand stock the shop wants
-- sitting on the shelf. The default is 0 — "no minimum", so nothing is
-- suggested that was not asked for. On-hand means the count of the SKU's
-- Available serialized parts (the same count /api/skus surfaces); when that
-- count falls below the minimum, the PO form's prompt lists the SKU with the
-- shortfall as the suggested line quantity, alongside the Need to Order
-- demand records.
--
-- The rule is serialized-only by domain enforcement (like buybackable, 0016):
-- consumables have no units, so a minimum is meaningless for them — the write
-- seams refuse it, and a serialized SKU must return its minimum to 0 before
-- it can change kind.
--
-- Plain ALTER like 0023: an additive column with a fixed default, so existing
-- rows carry 0 and behave exactly as before.

ALTER TABLE skus ADD COLUMN min_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (min_on_hand >= 0);
