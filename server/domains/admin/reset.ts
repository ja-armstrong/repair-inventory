import fs from "node:fs";
import path from "node:path";
import express, { type RequestHandler, type Router } from "express";
import { z } from "zod";
import { SANDBOX_BACKUP_STEM, type AppContext } from "../../domain.js";
import {
  MAX_RESTORE_UPLOAD_BYTES,
  backupsDirOf,
  createBackup,
  fileStamp,
  pendingRestoreMarkerPath,
  uniqueBackupName,
  validateBackupFile,
  type PendingRestoreMarker,
} from "./backups.js";

/**
 * The sandbox reset surface (sandbox ticket 05, spec decision 5): the
 * trainer's way to put data INTO the sandbox. Resetting replaces the SANDBOX
 * database with a backup — picked from `data/backups/` (newest first, both
 * instances' snapshots listed; `sandbox-` ones labeled) or uploaded — and it
 * is MANUAL ONLY: no schedule, no auto-reset, ever.
 *
 * The contract is exactly the production Restore contract (the ONE staged-
 * swap mechanism in `backups.ts`): validate BEFORE anything is touched
 * (integrity check + migration history), then auto-backup the current
 * sandbox database (its filename is the undo path and is shown in the
 * response), then stage the file + write THIS instance's marker. The swap
 * happens at the next server restart. The staging slot is the sandbox's own
 * (`pending-restore-sandbox…`, AppContext.stagedRestore) — a sandbox reset
 * can never collide with a production restore, whose stock upload route this
 * surface supersedes on the sandbox instance (it is not registered there).
 */

const pickSchema = z.object({ filename: z.string().min(1) });

/**
 * A bare backup filename: no path separators, so a picked filename can only
 * ever resolve inside data/backups/ — never at the production database or
 * anywhere else on disk.
 */
const SAFE_BACKUP_FILENAME = /^[^/\\]+\.sqlite$/i;

interface ResetSourceFile {
  filename: string;
  sizeBytes: number;
  modifiedAt: string;
  /** True when the file snapshots the SANDBOX database (`sandbox-` prefix). */
  sandboxSnapshot: boolean;
}

export function registerSandboxResetRoutes(
  router: Router,
  ctx: AppContext,
  requireAdminSession: RequestHandler
): void {
  const markerPath = pendingRestoreMarkerPath(ctx.dbPath, ctx.stagedRestore.markerStem);

  // ---- reset sources: every .sqlite in data/backups/, newest first -------
  //
  // Both instances' snapshots live in this one folder, so the list is the
  // trainer's menu: prod copies to reset from, and older `sandbox-`
  // snapshots (resetting a sandbox from an old sandbox snapshot is
  // legitimate — labeled so nobody mistakes one for a prod copy).

  router.get("/reset/sources", requireAdminSession, (_req, res) => {
    const dir = backupsDirOf(ctx.dbPath);
    const sources: ResetSourceFile[] = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter(
            (name) =>
              name.toLowerCase().endsWith(".sqlite") &&
              fs.statSync(path.join(dir, name)).isFile()
          )
          .map((name) => {
            const stats = fs.statSync(path.join(dir, name));
            return {
              filename: name,
              sizeBytes: stats.size,
              modifiedAt: stats.mtime.toISOString(),
              sandboxSnapshot: name.startsWith(`${SANDBOX_BACKUP_STEM}-`),
            };
          })
      : [];
    // Newest first (mtime desc; filename desc breaks same-mtime ties
    // deterministically).
    sources.sort((a, b) =>
      a.modifiedAt === b.modifiedAt
        ? b.filename.localeCompare(a.filename)
        : b.modifiedAt.localeCompare(a.modifiedAt)
    );
    res.json({ sources, empty: sources.length === 0 });
  });

  // ---- stage a reset (danger zone) ---------------------------------------

  router.post(
    "/reset",
    requireAdminSession,
    express.raw({ type: "application/octet-stream", limit: MAX_RESTORE_UPLOAD_BYTES }),
    async (req, res) => {
      const body: unknown = req.body;
      const dir = backupsDirOf(ctx.dbPath);
      const stamp = fileStamp(ctx.clock.now());
      fs.mkdirSync(dir, { recursive: true });
      // The staging candidate: EVERY source materializes here first — the
      // upload is written, the picked file is COPIED (never moved, so the
      // original backup always survives in data/backups/) — and validation
      // runs on the candidate, never on the source in place. The candidate
      // name carries this instance's marker stem: both instances' files land
      // in the same data/backups/ folder, so same-second requests of the two
      // instances must never collide on one candidate file.
      const candidatePath = path.join(
        dir,
        uniqueBackupName(dir, `${ctx.stagedRestore.markerStem}-staging-${stamp}.sqlite`)
      );
      // A read-only validation open can leave WAL sidecars next to the
      // candidate; they are removed before the rename — a stale sidecar
      // beside a same-named future file would be corruption on open.
      const removeSidecars = () => {
        for (const suffix of ["-wal", "-shm"]) {
          fs.rmSync(candidatePath + suffix, { force: true });
        }
      };
      const removeCandidate = () => {
        fs.rmSync(candidatePath, { force: true });
        removeSidecars();
      };

      if (Buffer.isBuffer(body) && body.length > 0) {
        // Upload path: same shape as the production Restore route — raw
        // bytes as application/octet-stream, original name in ?filename=.
        const originalName = typeof req.query.filename === "string" ? req.query.filename : "";
        if (!/\.sqlite$/i.test(originalName)) {
          res.status(400).json({ error: "the uploaded file must be named *.sqlite" });
          return;
        }
        fs.writeFileSync(candidatePath, body);
      } else if (body !== null && typeof body === "object") {
        // Pick path: a filename straight from the sources list.
        const parsed = pickSchema.safeParse(body);
        if (!parsed.success) {
          res.status(400).json({
            error:
              "provide a filename from the reset sources list, or upload the .sqlite file as the raw request body (application/octet-stream)",
          });
          return;
        }
        const filename = parsed.data.filename;
        if (!SAFE_BACKUP_FILENAME.test(filename) || filename.includes("..")) {
          res.status(400).json({ error: `not a backup filename: ${filename}` });
          return;
        }
        const sourcePath = path.join(dir, filename);
        if (!fs.existsSync(sourcePath)) {
          res.status(404).json({
            error: `no backup named ${filename} exists in data/backups/ — reload the sources list`,
          });
          return;
        }
        fs.copyFileSync(sourcePath, candidatePath);
      } else {
        res.status(400).json({
          error:
            "provide a filename from the reset sources list, or upload the .sqlite file as the raw request body (application/octet-stream)",
        });
        return;
      }

      // Validate BEFORE anything is touched: on failure nothing is backed up,
      // nothing is staged, and the sandbox keeps running on its current data.
      const validation = validateBackupFile(candidatePath);
      if (!validation.ok) {
        removeCandidate();
        res.status(400).json({ error: validation.error });
        return;
      }
      removeSidecars();

      // Danger rule ordering (the prod Restore contract, exactly): the
      // CURRENT sandbox database is backed up first — its filename is the
      // undo path and is shown in the response.
      const backup = await createBackup(ctx.db, ctx.dbPath, ctx.clock, ctx.backupStem);

      // Stage the swap under this instance's marker stem, so the two
      // instances' staged files can never overwrite each other in the
      // shared folder.
      const stagedName = uniqueBackupName(dir, `${ctx.stagedRestore.markerStem}-${stamp}.sqlite`);
      fs.renameSync(candidatePath, path.join(dir, stagedName));
      const marker: PendingRestoreMarker = {
        file: stagedName,
        requestedAt: ctx.clock.now().toISOString(),
        backup: backup.filename,
      };
      fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
      console.log(
        `[admin] sandbox reset staged: ${stagedName} — current sandbox database backed up as ` +
          `${backup.filename}; restart the server to complete the swap`
      );
      res.json({
        ok: true,
        backup: backup.filename,
        staged: stagedName,
        restartRequired: true,
        note:
          "The swap happens at the next server restart. Resetting logs everyone out of the sandbox " +
          "(sessions live in the database), and users created for training vanish — the sandbox then " +
          "serves the data from the chosen backup.",
      });
    }
  );
}
