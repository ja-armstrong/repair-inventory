-- 0023: the SKU's default source link (ticket 11, spec decision 10).
--
-- One free-text link per SKU ("source.com/part" style). The field is TEXT,
-- not a foreign key: there is no supplier entity by design at this shop
-- size — the link is a convenience, never a lock. New PO lines and Need to
-- Order demand records pre-fill their source/supplier from it, but every
-- line stays editable per order.
--
-- Whether a stored value renders clickable is decided at READ time (the
-- web's shared strict URL detector), never stored — a value the detector
-- cannot vouch for renders as plain text.
--
-- Plain ALTER like 0020: an additive nullable column, so existing rows
-- carry NULL ("no default yet") and behave exactly as before.

ALTER TABLE skus ADD COLUMN default_source_url TEXT;
