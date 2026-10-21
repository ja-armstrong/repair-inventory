import Database from "better-sqlite3";

/**
 * Opens the SQLite database in WAL mode with foreign keys enforced, per
 * ADR-0001 (SQLite prototype, Postgres migration target; no SQLite-only SQL
 * features in migrations or queries).
 */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
