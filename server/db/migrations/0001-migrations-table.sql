-- 0001: the migrations table itself (schema machinery).
-- The runner also ensures this table exists before applying anything — it
-- must, in order to record migrations — so this file is idempotent. It exists
-- so the numbering convention has a concrete first entry and the table's
-- creation is recorded in the audit trail.
CREATE TABLE IF NOT EXISTS migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
