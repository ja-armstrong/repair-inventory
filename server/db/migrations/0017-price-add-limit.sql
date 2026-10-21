-- 0017: per-device price add limit (ticket 28).
--
-- CONTEXT.md (Approval): during Awaiting approval the manager sets an
-- optional **Price Add Limit** per device — default $0, which is exactly
-- today's behavior (a tech may not add post-approval cost at all). After
-- the batch is Open, a tech may add parts and record consumable usage on
-- the device as long as the device's post-approval cost additions stay
-- within the limit; over-limit additions are refused with the options:
-- manager override, retriage, or Unrepairable.
--
-- NOT NULL DEFAULT 0 is truthful for every existing row: no device had a
-- limit, and 0 means "no post-approval headroom", not "unlimited". The
-- spend itself is DERIVED, never stored (see batchparts/queries.ts
-- devicePostApprovalSpendCents): active attachments + consumable usage
-- created after the batch's approved_at. A plain ADD COLUMN works portably.

ALTER TABLE devices
  ADD COLUMN price_add_limit_cents INTEGER NOT NULL DEFAULT 0
  CHECK (price_add_limit_cents >= 0);
