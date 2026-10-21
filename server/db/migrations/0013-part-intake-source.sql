-- 0013: intake source on every serialized part (ticket 13).
--
-- Parts enter inventory three ways (CONTEXT.md: Intake Source): purchase
-- order, migration, or salvage. Expense reporting (ticket 12) counts only
-- purchase-order intake, so the source lives on the part row — one plain
-- TEXT column, queryable per part and GROUP BY-able in SQL.
--
-- The CHECK is added with the column (portable ALTER TABLE; verified against
-- SQLite's ADD COLUMN rules — a CHECK on the new column alone is allowed).
-- NOT NULL cannot be added this way without a falsifying DEFAULT (SQLite has
-- no ADD COLUMN ... SET NOT NULL, and a table rebuild would have to DROP the
-- parent table while foreign keys are enforced — not portable), so nullability
-- is enforced at the write seams instead: parts/intake.ts and the PO receiving
-- path always set the column explicitly, and the invariant "no part row has a
-- NULL intake source" is asserted by tests. A writer that bypasses both seams
-- gets a NULL, which is a loud data defect, not a silently guessed source.
--
-- Backfill of pre-source rows (data-derived, not guessed):
-- - a part linked from a received expected serial (part_id) came in on a
--   purchase order → 'purchase-order';
-- - every other existing row was created by the ad-hoc bulk intake endpoint
--   (POST /api/skus/:id/parts, quantity 1..200) — the act migration intake
--   now formalizes → 'migration'. Salvage intake did not exist before this
--   ticket, so no row can truthfully be 'salvage'.

ALTER TABLE serialized_parts
  ADD COLUMN intake_source TEXT
  CHECK (intake_source IN ('purchase-order', 'migration', 'salvage'));

UPDATE serialized_parts
   SET intake_source = 'purchase-order'
 WHERE id IN (SELECT part_id FROM purchase_order_expected_serials WHERE part_id IS NOT NULL);

UPDATE serialized_parts
   SET intake_source = 'migration'
 WHERE intake_source IS NULL;
