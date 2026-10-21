-- 0014: per-part price override (ticket 23).
--
-- Each serialized part carries its own price, defaulting to its SKU price
-- (CONTEXT.md: Part Price). NULL means "use the SKU's current price"; a
-- value is the override (e.g. an eBay-sourced unit bought at a price that
-- is not the catalog price). The effective price — override ?? SKU price —
-- is resolved in exactly one place: parts/effective-price.ts.
--
-- No backfill: NULL is precisely the pre-ticket behavior (every part priced
-- at its SKU), so existing rows keep their meaning without falsifying data.
--
-- Numbering note: the ticket text says "migration 0015", but 0014 was free
-- (ticket 22 added no migration — its "0014 remains the latest" note refers
-- to the next free number) and the migration runner (server/db/migrate.ts)
-- refuses gaps. This file takes the next free number; nothing was renumbered.

ALTER TABLE serialized_parts
  ADD COLUMN price_cents INTEGER
  CHECK (price_cents IS NULL OR price_cents >= 0);
