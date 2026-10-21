import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { Clock } from "../clock.js";

const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url));

const MIGRATION_FILE_PATTERN = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/;

interface MigrationRow {
  name: string;
}

/**
 * Applies numbered SQL migration files (0001-<slug>.sql, 0002-<slug>.sql, ...)
 * from `server/db/migrations/` in order, recording each in the `migrations`
 * table. Migrations are additive and never renumbered; later tickets only add
 * files to this directory.
 *
 * The runner creates the `migrations` table itself if it is missing — it must
 * exist before anything can be recorded — and migration 0001 defines the same
 * table idempotently so the numbering convention has a concrete first entry
 * and the table's creation shows up in the audit trail.
 *
 * `applied_at` is stamped through the injectable clock, never wall time.
 */
export function knownMigrationNames(): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

export function migrate(db: Database.Database, clock: Clock): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare("SELECT name FROM migrations").all() as MigrationRow[]).map((row) => row.name)
  );

  const files = knownMigrationNames();

  files.forEach((file, index) => {
    const match = MIGRATION_FILE_PATTERN.exec(file);
    if (!match) {
      throw new Error(
        `migration file name must match NNNN-slug.sql (lowercase, hyphenated): ${file}`
      );
    }
    const number = Number(match[1]);
    if (number !== index + 1) {
      throw new Error(
        `migrations must number from 0001 with no gaps and never renumber: expected ${
          String(index + 1).padStart(4, "0")
        }-*.sql, found ${file}`
      );
    }
  });

  for (const name of applied) {
    if (!files.includes(name)) {
      throw new Error(
        `migration recorded in the database is missing from the migrations directory: ${name}`
      );
    }
  }

  const record = db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)");

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    // Some migrations must widen a parent table's CHECK constraint (SQLite
    // cannot ALTER a CHECK). The portable shape is the 0015-style cascade
    // (copy every child, drop children first); for a parent with MANY
    // children — users — the migration may instead declare itself with the
    // marker below, and the runner runs THAT ONE FILE with foreign-key
    // enforcement disabled. The transaction still wraps the file (a
    // half-applied migration rolls back), the child FK clauses reference the
    // table by name and resolve again after the in-place rebuild, and the
    // setting is restored immediately after — no other migration's
    // enforcement is touched.
    const FK_OFF_MARKER = "-- foreign-keys: disabled for this migration";
    const firstLine = sql.slice(0, sql.indexOf("\n")).trim();
    const disableForeignKeys = firstLine === FK_OFF_MARKER;
    const apply = db.transaction(() => {
      db.exec(sql);
      record.run(file, clock.now().toISOString());
    });
    if (disableForeignKeys) {
      db.pragma("foreign_keys = OFF");
      try {
        apply();
      } finally {
        db.pragma("foreign_keys = ON");
      }
    } else {
      apply();
    }
  }
}
