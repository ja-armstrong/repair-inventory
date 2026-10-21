-- 0008: audits and cycle counts (ticket 10) — the counting discipline.
--
-- An Audit is a window: it opens (scheduled at the audit_interval_months
-- cadence, or manually), any user scans (types) serials while it is open,
-- and closing settles with no grace — due-but-unscanned parts become
-- Unavailable, the shrink signal (CONTEXT.md: Unavailable includes
-- "failed audit").
--
-- Due-ness per spec story 61/66: an audit demands exactly the serialized
-- parts whose last count falls on or before the previous audit. It is
-- computed at OPEN time and snapshotted into audit_parts, keyed to:
--   anchor_at — end of the previous audit's open DAY (day-granular, so a
--     count taken during the previous audit itself is due again at the next
--     one; only counts taken between audits — cycle counts — exempt).
--     NULL on the first audit: with no previous audit, everything in
--     circulation is due.
--   The snapshot also means a part added while the window is open is never
--   demanded by that audit — it post-dates the demand list.
--
-- audit_parts.outcome is stamped at CLOSE: 'counted' (scanned during the
-- window), 'failed' (due-but-unscanned and still in circulation → the part
-- became Unavailable), or 'moved' (accounted for mid-window by a user's
-- status change). NULL while the window is open.

CREATE TABLE audits (
  id INTEGER PRIMARY KEY,
  scheduled_at TEXT,
  opened_at TEXT NOT NULL,
  opened_by INTEGER NOT NULL REFERENCES users(id),
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id),
  previous_audit_id INTEGER REFERENCES audits(id),
  anchor_at TEXT
);
CREATE INDEX audits_opened ON audits (opened_at);

CREATE TABLE audit_parts (
  audit_id INTEGER NOT NULL REFERENCES audits(id),
  part_id INTEGER NOT NULL REFERENCES serialized_parts(id),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('counted', 'failed', 'moved')),
  PRIMARY KEY (audit_id, part_id)
);
CREATE INDEX audit_parts_part ON audit_parts (part_id);
