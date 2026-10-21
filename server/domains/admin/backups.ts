import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Clock } from "../../clock.js";
import type { StagedRestoreSeam } from "../../domain.js";
import { knownMigrationNames, migrate } from "../../db/migrate.js";
import { openDatabase } from "../../db/connection.js";

/**
 * The admin domain's database-file seam (ticket 18): consistent online
 * backups, restore validation + staged swap, and the wipe-and-recreate used
 * by "clear the database".
 *
 * Backup mechanics (ADR-0001: the file backup IS the maintainer's disaster
 * recovery, so this path must be obvious and safe): backups go through
 * better-sqlite3's `db.backup()` — SQLite's online backup API — which yields
 * a consistent snapshot even while other connections write; the database is
 * never copied by reading the file while writes may land. Backups land in a
 * `backups/` directory next to the database file (`data/backups` in the
 * default layout, already gitignored).
 *
 * Restore mechanics — the ONE chosen mechanism, documented: a restore is
 * staged, never swapped in-process. Swapping the file under a live process
 * would strand every domain's prepared statements on the dead handle. So:
 * upload → validate → auto-backup the current database → stage the file in
 * `backups/` + write a pending-swap marker next to the database → the swap
 * happens at the next server start (`applyPendingRestore`), which backs up
 * the current state once more, replaces the file, and lets the normal
 * startup migration run apply anything the staged file was missing.
 *
 * Staging slots are PER INSTANCE (sandbox ticket 05): both databases live in
 * `data/`, so a marker name shared between them would let a sandbox reset
 * staged from the /sandbox panel be swapped into the PRODUCTION file at the
 * next startup. The marker filename, staged-file names, and pre-swap backup
 * name all come from the instance's StagedRestoreSeam (AppContext.stagedRestore):
 * production `pending-restore`, sandbox `pending-restore-sandbox` — and the
 * startup swap checks each instance's marker against that instance's own
 * database path, independently.
 * Writes made between the restore request and the restart are lost — that is
 * inherent to a restart swap and stated plainly in the API response.
 */

/** Uploads are single SQLite files; this cap is generous by design. Shared
 * by the production restore route and the sandbox reset routes — one limit,
 * one source. */
export const MAX_RESTORE_UPLOAD_BYTES = "512mb";

export interface PendingRestoreMarker {
  file: string;
  requestedAt: string;
  backup: string;
}

export function backupsDirOf(dbPath: string): string {
  return path.join(path.dirname(dbPath), "backups");
}

/**
 * The pending-swap marker file for THIS instance's staging slot, next to the
 * instance's database. The marker stem comes from the instance's seam — the
 * filename is what keeps a sandbox reset and a production restore from ever
 * colliding (both databases live in data/).
 */
export function pendingRestoreMarkerPath(dbPath: string, markerStem: string): string {
  return path.join(path.dirname(dbPath), `${markerStem}.json`);
}

/** UTC timestamp for backup filenames: YYYYMMDD-HHMMSS. */
export function fileStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/**
 * A filename in `dir` that does not already exist: the requested name, then
 * `-2`, `-3`, … appended before the extension on a same-stamp collision
 * (final review F4). Two backups within the same second must never overwrite
 * each other — the pre-action backup IS the safety net, and a silent
 * replacement of that artifact would break the danger rule.
 */
export function uniqueBackupName(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let count = 1;
  while (fs.existsSync(candidate)) {
    count += 1;
    candidate = path.join(dir, `${stem}-${count}${ext}`);
  }
  return path.basename(candidate);
}

/**
 * One consistent online backup, saved into the backups directory under a
 * timestamped name. The stamp comes from the injectable clock (tests pin it);
 * a same-second collision gets an incrementing suffix instead of replacing
 * the earlier artifact — the earlier backup is never destroyed. The filename
 * stem is the caller's instance seam (AppContext.backupStem): production
 * saves `repair-inventory-…`, the sandbox saves `sandbox-…` — both land in
 * the same `data/backups/` folder, so the prefix is what says WHICH
 * database a file snapshots.
 */
export async function createBackup(
  db: Database.Database,
  dbPath: string,
  clock: Clock,
  backupStem: string
): Promise<{ filename: string; path: string }> {
  const dir = backupsDirOf(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const filename = uniqueBackupName(dir, `${backupStem}-${fileStamp(clock.now())}.sqlite`);
  const target = path.join(dir, filename);
  // The target is guaranteed absent (db.backup() requires an empty or absent
  // destination), so no pre-delete is needed — and none may silently discard
  // an earlier backup.
  await db.backup(target);
  return { filename, path: target };
}

/**
 * Validates a candidate database file for restore: readable SQLite,
 * `PRAGMA integrity_check` clean, a `migrations` table present, and an
 * applied-migration set that is a prefix (in order) of the migrations this
 * server version knows — so the normal startup migration run can finish the
 * file. Anything else is refused loudly with the reason.
 */
export function validateBackupFile(filePath: string): { ok: true } | { ok: false; error: string } {
  let check: Database.Database;
  try {
    check = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    return { ok: false, error: `not a readable SQLite file: ${(error as Error).message}` };
  }
  try {
    const integrity = check.pragma("integrity_check", { simple: true }) as string;
    if (integrity !== "ok") {
      return { ok: false, error: `integrity_check failed: ${integrity}` };
    }
    const hasMigrations = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
      .get();
    if (!hasMigrations) {
      return {
        ok: false,
        error: "not a repair-inventory database: the migrations table is missing",
      };
    }
    const applied = (
      check.prepare("SELECT name FROM migrations ORDER BY name").all() as Array<{ name: string }>
    ).map((row) => row.name);
    // Names are zero-padded (0001-…), so name order IS application order.
    const known = knownMigrationNames();
    for (let index = 0; index < applied.length; index++) {
      if (applied[index] !== known[index]) {
        return {
          ok: false,
          error: `migration state mismatch at position ${index + 1}: the file has ${
            applied[index]
          } but this server expects ${known[index] ?? "no migration there"}`,
        };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `could not inspect the uploaded file: ${(error as Error).message}` };
  } finally {
    check.close();
  }
}

/**
 * Wipes every app table and recreates the schema from the migration files —
 * the "clear the database" mechanism. Dropping the `migrations` table too and
 * re-running the runner keeps ONE schema-building path (the migration runner);
 * no parallel "fresh schema" script exists to drift. Foreign keys are dropped
 * for the wipe itself (rows reference each other), then re-enabled.
 */
export function wipeAndRecreate(db: Database.Database, clock: Clock): void {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  db.pragma("foreign_keys = OFF");
  try {
    const drop = db.transaction(() => {
      for (const name of tables) {
        // Identifiers come from our own schema; doubling quotes keeps the
        // DROP safe even if a name ever contained one.
        db.exec(`DROP TABLE "${name.replace(/"/g, '""')}"`);
      }
    });
    drop();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  migrate(db, clock);
}

/**
 * The startup half of the staged swap: if THIS instance's pending marker
 * exists, validate the staged file again, back up the CURRENT database (the
 * swap is destructive — danger rule), replace the database file, and remove
 * the marker. The caller then opens + migrates the restored file normally.
 * Returns the applied marker, or undefined when no swap was pending.
 *
 * Called once per instance at startup with that instance's seam — each
 * marker is checked against its own database path, so a sandbox reset can
 * never be applied to the production file (or the reverse).
 */
export async function applyPendingRestore(
  dbPath: string,
  staging: StagedRestoreSeam
): Promise<PendingRestoreMarker | undefined> {
  const markerPath = pendingRestoreMarkerPath(dbPath, staging.markerStem);
  if (!fs.existsSync(markerPath)) {
    return undefined;
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as PendingRestoreMarker;
  const staged = path.join(backupsDirOf(dbPath), marker.file);
  if (!fs.existsSync(staged)) {
    throw new Error(
      `a pending ${staging.label} restore is recorded (${marker.file}, requested ${marker.requestedAt}) but the staged file is missing`
    );
  }
  // Defense in depth: the file was validated at request time; validate again
  // before it becomes the live database. A failure here aborts startup loudly.
  const validation = validateBackupFile(staged);
  if (!validation.ok) {
    throw new Error(
      `pending ${staging.label} restore failed validation at startup: ${validation.error}`
    );
  }

  let preSwapBackup: string | undefined;
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    try {
      const current = openDatabase(dbPath);
      try {
        const dir = backupsDirOf(dbPath);
        fs.mkdirSync(dir, { recursive: true });
        // Startup ops code, not domain logic: wall time names the file. The
        // stem is the instance's — both instances' pre-swap backups land in
        // the shared data/backups/, so the name says which database it held.
        const filename = uniqueBackupName(
          dir,
          `${staging.preSwapStem}-${fileStamp(new Date())}.sqlite`
        );
        const target = path.join(dir, filename);
        await current.backup(target);
        preSwapBackup = filename;
      } finally {
        current.close();
      }
    } catch (error) {
      // The current database may itself be why a restore was requested; a
      // failed pre-swap backup is announced loudly, not swallowed — the swap
      // still proceeds because replacing the file is the point.
      console.warn(
        `[admin] pre-swap backup of the ${staging.label} database FAILED (${(error as Error).message}); replacing it anyway`
      );
    }
  }

  // Remove WAL sidecars that belong to the old file: after the clean close
  // above they hold nothing, but leaving them next to the new file would be
  // corruption on open.
  for (const suffix of ["-wal", "-shm"]) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
  fs.renameSync(staged, dbPath);
  fs.rmSync(markerPath, { force: true });
  console.log(
    `[admin] ${staging.label} restore completed at ${new Date().toISOString()}: database replaced with ${marker.file}` +
      (preSwapBackup ? ` (pre-swap backup: ${preSwapBackup})` : "") +
      ` — requested at ${marker.requestedAt}`
  );
  return marker;
}
