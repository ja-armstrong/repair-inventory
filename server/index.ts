import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { createApp } from "./app.js";
import { systemClock } from "./clock.js";
import { openDatabase } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { createEmailPlugFromEnv } from "./domains/auth/email-plug.js";
import { allowedEmailDomains } from "./domains/auth/users.js";
import { applyPendingRestore } from "./domains/admin/backups.js";
import {
  PROD_ADMIN_COOKIE,
  PROD_BACKUP_STEM,
  PROD_MOUNT_PREFIX,
  PROD_SESSION_COOKIE,
  PROD_STAGED_RESTORE,
  SANDBOX_ADMIN_COOKIE,
  SANDBOX_BACKUP_STEM,
  SANDBOX_MOUNT_PREFIX,
  SANDBOX_SESSION_COOKIE,
  SANDBOX_STAGED_RESTORE,
} from "./domain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, "..", ".env");
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const dbPath = path.resolve(process.env.DB_PATH ?? path.join("data", "repair-inventory.sqlite"));
const port = Number(process.env.PORT ?? 3000);

// Fail fast on a misconfigured email allowlist: an unset/empty/invalid
// ALLOWED_EMAIL_DOMAINS would otherwise surface only on the first login or
// user-creation request. The rule lives in the auth domain; startup just
// proves the configuration parses.
allowedEmailDomains();

// A staged swap (a prod restore staged from /admin, or a sandbox reset
// staged from /sandbox/admin) is applied BEFORE its database is opened: back
// up the current file, swap in the staged one, and let the normal startup
// migration run finish the restored schema. EACH instance has its OWN
// staging slot (its own marker filename — AppContext.stagedRestore), and the
// two markers are checked independently against their own database paths: a
// sandbox reset can never be swapped into the production file, nor a
// production restore into the sandbox.
await applyPendingRestore(dbPath, PROD_STAGED_RESTORE);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const clock = systemClock();

const db = openDatabase(dbPath);
migrate(db, clock);

// The sandbox instance (spec: sandbox environment): a second, fully wired
// app in the SAME process with its OWN SQLite file beside the production
// one. Its cookie names are hard-derived (never configurable) so the two
// instances can never share session state, and every domain registers in it
// unchanged — the sandbox differs only at these seams, never inside a
// domain rule. First run is an empty migrated database: no restore, no
// seeding — the sandbox is populated only by an explicit reset.
const sandboxDbPath = path.join(path.dirname(dbPath), "sandbox.sqlite");
// The sandbox's own staged swap (a pending reset) applies before its file is
// opened — same mechanism, its own marker.
await applyPendingRestore(sandboxDbPath, SANDBOX_STAGED_RESTORE);
const sandboxDb = openDatabase(sandboxDbPath);
migrate(sandboxDb, clock);

const app = createApp({
  db,
  clock,
  dbPath,
  sessionCookie: PROD_SESSION_COOKIE,
  adminCookie: PROD_ADMIN_COOKIE,
  mountPrefix: PROD_MOUNT_PREFIX,
  backupStem: PROD_BACKUP_STEM,
  stagedRestore: PROD_STAGED_RESTORE,
  // Both instances run the SAME email selection: Resend when RESEND_KEY is
  // set, console logging otherwise (the helper reads the env; a failed send
  // fails loud). The label only names the instance in the startup line.
  emailPlug: createEmailPlugFromEnv("production"),
});
const sandboxApp = createApp({
  db: sandboxDb,
  clock,
  dbPath: sandboxDbPath,
  sessionCookie: SANDBOX_SESSION_COOKIE,
  adminCookie: SANDBOX_ADMIN_COOKIE,
  mountPrefix: SANDBOX_MOUNT_PREFIX,
  // Sandbox backups are named sandbox-YYYYMMDD-HHMMSS.sqlite in the SAME
  // data/backups folder — the prefix is what tells the two databases'
  // snapshots apart (sandbox ticket 04).
  backupStem: SANDBOX_BACKUP_STEM,
  stagedRestore: SANDBOX_STAGED_RESTORE,
  // The sandbox runs the SAME email selection as production — one shared
  // rule, one WHY (see createEmailPlugFromEnv). Only the link's mount
  // prefix marks a sandbox email as sandbox.
  emailPlug: createEmailPlugFromEnv("sandbox"),
});

serveWebClient(sandboxApp);

// The sandbox mounts BEFORE the production static/SPA fallback is added:
// the fallback only excludes "/api" paths, so mounted later it would swallow
// /sandbox/api/... requests (they do not start with "/api") and answer them
// with the SPA shell instead of the sandbox instance. Express prefix-strips
// the mount prefix, so every domain route registers unchanged.
app.use(SANDBOX_MOUNT_PREFIX, sandboxApp);

serveWebClient(app);

if (!process.env.ADMIN_KEY?.trim()) {
  console.warn(
    "[admin] ADMIN_KEY is not set — the admin panel (/admin) is DISABLED: every /admin route answers 404. " +
      "Set ADMIN_KEY in .env to enable settings, backups, and the danger zone."
  );
}

app.listen(port, "0.0.0.0", () => {
  console.log(`repair-inventory listening on http://0.0.0.0:${port}`);
  console.log(`  prod db:    ${dbPath}`);
  console.log(`  sandbox db: ${sandboxDbPath} (mounted at ${SANDBOX_MOUNT_PREFIX}, own cookie names)`);
});

/**
 * Serves the built web client (produced by `npm run build`) from the same
 * origin as the API. ONE dist serves BOTH instances: assets are referenced
 * at their existing absolute /assets paths, which the production mount
 * answers; the sandbox gets its own static mount + SPA fallback so deep
 * links like /sandbox/batches load the app shell. In dev, Vite serves the
 * client itself and proxies /health, /api, and /sandbox here, so this is a
 * no-op until the dist exists. API routes live under /api — inside a
 * mounted sub-app Express has already stripped the /sandbox prefix, so one
 * "/api" check covers both instances and the fallback never swallows an
 * API request.
 */
function serveWebClient(app: Express): void {
  const webDist = path.join(here, "..", "web", "dist");
  if (!fs.existsSync(webDist)) {
    return;
  }
  app.use(express.static(webDist));
  // SPA fallback: let client-side routes (e.g. /batches, /sandbox/batches)
  // load the app shell.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(webDist, "index.html"));
  });
}
