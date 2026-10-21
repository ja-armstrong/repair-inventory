import type Database from "better-sqlite3";

/**
 * The SQL console's execution helpers (ticket 18). Guard rails live in the
 * route; this module only runs a statement and shapes the result:
 * - read path: a single prepared SELECT, returning column names + rows.
 * - the console distinguishes "one statement" (prepared, so rows or a
 *   change count come back) from "several statements" (`db.exec`, which
 *   returns no per-statement data).
 */
export interface SqlReadResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

/**
 * The single statement to run, with any trailing semicolons removed — or
 * `undefined` when the input is empty or contains more than one statement
 * (the caller refuses those loudly; `db.prepare` compiling only the first
 * statement would silently ignore the rest).
 */
export function singleStatement(sql: string): string | undefined {
  const trimmed = sql
    .replace(/;+\s*$/, "")
    .trim();
  if (trimmed === "" || trimmed.includes(";")) {
    return undefined;
  }
  return trimmed;
}

export function runSelect(db: Database.Database, sql: string): SqlReadResult {
  const statement = db.prepare(sql);
  const rows = statement.all() as Record<string, unknown>[];
  return {
    columns: statement.columns().map((column) => column.name),
    rows,
    rowCount: rows.length,
  };
}
