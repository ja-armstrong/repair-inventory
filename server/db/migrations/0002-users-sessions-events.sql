-- 0002: users, passwordless login (magic links + sessions), and the
-- append-only timeline events table that every later domain writes to.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('manager', 'tech')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

-- Single-use magic-link tokens: 15-minute expiry, consumed on redemption.
CREATE TABLE login_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Persistent sessions: no server-side expiry (login persists indefinitely;
-- the browser cookie caps at 400 days). Keyed by random token in a cookie.
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- The one timeline: typed notes and system events from every domain merge
-- here (actor, timestamp, action, optional old->new values, entity reference).
-- Append-only; read ordered by id. Portable SQL only, per ADR-0001.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  actor_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX events_entity ON events (entity_type, entity_id, id);
