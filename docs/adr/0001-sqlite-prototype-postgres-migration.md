# 0001: SQLite for the prototype, Postgres as the migration target

This is a solo-built prototype maintained by a non-developer repair tech, intended to be pitched to the dev team and possibly run solo for years. We store data in SQLite — one file, zero administration, trivially backed up, comfortably sized for one site, ≤3 users, ~350 repairs/month — rather than starting on Postgres, which would demand a running service the maintainer would have to babysit. The migration path is deliberate and documented: boring TypeScript monolith, portable schema, no SQLite-only features; when the dev team adopts it, moving to Postgres is a scheduled dump-and-load, and that path *is* part of the pitch.

## Consequences

- SQLite's single-writer model is acceptable at this concurrency but must be revisited if concurrent write contention appears.
- A dev team evaluating this codebase will ask "why SQLite?"; this ADR is the answer.
- Application data accumulates in a single file: regular file backups are the maintainer's disaster recovery. Make the backup path obvious in the UI.
