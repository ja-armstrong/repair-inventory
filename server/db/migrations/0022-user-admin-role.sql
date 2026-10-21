-- foreign-keys: disabled for this migration
-- 0022: the admin role.
--
-- A third role, "admin": today it carries EVERY manager power — the
-- separation is in name only, reserved for later functionality. The one
-- predicate every manager-power check goes through is
-- hasManagerPowers(role) (auth/session.ts); nothing anywhere compares
-- against the literal "manager" except that predicate.
--
-- users.role's CHECK must gain 'admin', and SQLite cannot ALTER a CHECK, so
-- users is rebuilt in place. users is a PARENT table with ~20 descendants
-- (sessions, events, batches, devices, orders, ...), and foreign keys are
-- enforced throughout (connection.ts): the 0015-style cascade would have to
-- copy every descendant's full accumulated schema. Instead this migration
-- declares "-- foreign-keys: disabled for this migration" (its first line,
-- honored by db/migrate.ts for this file only): the swap below runs with FK
-- enforcement off, inside the runner's transaction — a half-applied swap
-- rolls back — and the descendants' `REFERENCES users(id)` clauses resolve
-- again the moment the rebuilt table takes the users name back. Every
-- existing row is carried over untouched.

CREATE TABLE users_rebuilt (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'tech')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);
INSERT INTO users_rebuilt (id, email, role, active, created_at)
  SELECT id, email, role, active, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_rebuilt RENAME TO users;
