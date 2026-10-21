import type { Express } from "express";
import type Database from "better-sqlite3";
import type { Clock } from "./clock.js";
import type { EmailPlug } from "./domains/auth/email-plug.js";

/**
 * What every domain gets when it registers: the database handle, the
 * injectable clock, the path the database file lives at (the admin domain's
 * backup/restore/clear seams need the file location, not just the open
 * handle), and the instance seams — cookie names, mount prefix, and the
 * email plug.
 */
export interface AppContext {
  db: Database.Database;
  clock: Clock;
  dbPath: string;
  /** Cookie name holding the user session token (prod: "session"). */
  sessionCookie: string;
  /** Cookie name holding the admin panel's key-session token (prod: "admin_session"). */
  adminCookie: string;
  /** The URL prefix this instance is mounted under (prod: "", sandbox: "/sandbox"). */
  mountPrefix: string;
  /**
   * The stem of backup filenames this instance creates: the prod panel saves
   * `repair-inventory-YYYYMMDD-HHMMSS.sqlite`, the sandbox panel
   * `sandbox-YYYYMMDD-HHMMSS.sqlite` — same `data/backups/` folder, so the
   * prefix is how a maintainer tells whose snapshot a file is. An explicit
   * seam like the cookie names, not a derivation from the database filename:
   * the name is a documented contract (README), not an accident of layout.
   */
  backupStem: string;
  /**
   * This instance's staged-swap seam (sandbox ticket 05): where a staged
   * database swap records its pending marker and staged file, which startup
   * pre-swap backup name it uses, and which admin surfaces stage swaps. An
   * explicit per-instance constant — the marker filename MUST differ between
   * the instances, because both databases live in `data/`: a shared marker
   * name would let a sandbox reset staged from the /sandbox panel be swapped
   * into the PRODUCTION database at the next startup (and the other way).
   */
  stagedRestore: StagedRestoreSeam;
  /**
   * The one seam login links flow through, picked by the composition root:
   * BOTH instances run the same selection — Resend when RESEND_KEY is set,
   * the console-logging plug otherwise (spec: sandbox environment, decision
   * 7, reversed 2026-10-06 — the WHY lives on createEmailPlugFromEnv). A
   * sandbox link differs from a prod link only by its `/sandbox` prefix.
   */
  emailPlug: EmailPlug;
}

/**
 * The instance seams, as named constants rather than globals: TWO instances
 * of the app run in one process (production and the sandbox at /sandbox,
 * each with its own database), and the composition root (server/index.ts)
 * hands each its values explicitly. The sandbox values are hard-derived —
 * not environment-configurable — so the two instances can never be pointed
 * at each other's cookies or paths by accident (spec: sandbox environment,
 * decision 4).
 */
export const PROD_SESSION_COOKIE = "session";
export const PROD_ADMIN_COOKIE = "admin_session";
export const PROD_MOUNT_PREFIX = "";
export const PROD_BACKUP_STEM = "repair-inventory";
export const SANDBOX_SESSION_COOKIE = "sandbox_session";
export const SANDBOX_ADMIN_COOKIE = "sandbox_admin_session";
export const SANDBOX_MOUNT_PREFIX = "/sandbox";
export const SANDBOX_BACKUP_STEM = "sandbox";

/**
 * The staged-swap seam for ONE instance (see AppContext.stagedRestore): the
 * marker and staged-file names, the startup pre-swap backup name, and which
 * admin surfaces on this instance stage a swap. `applyPendingRestore` is
 * called once per instance at startup with that instance's seam, so each
 * marker is validated against its own database file — a sandbox reset and a
 * production restore can never cross.
 */
export interface StagedRestoreSeam {
  /** Names the instance in loud startup/console messages ("production"/"sandbox"). */
  label: string;
  /**
   * The staging slot's stem: the marker file is `<markerStem>.json` next to
   * this instance's database, staged files are `<markerStem>-<stamp>.sqlite`.
   * MUST be unique per instance — see AppContext.stagedRestore for why.
   */
  markerStem: string;
  /** Stem of the pre-swap backup applyPendingRestore takes before replacing the file. */
  preSwapStem: string;
  /**
   * Whether the stock POST /api/admin/restore upload route registers on this
   * instance. Production: yes. The sandbox: NO — its reset routes supersede
   * the stock route (they stage into the sandbox's own slot), and a second
   * route with a second meaning on one URL is a defect.
   */
  restoreRoute: boolean;
  /**
   * Whether the sandbox reset surface (backup sources list + POST reset)
   * registers on this instance. The sandbox: yes — resetting from a backup
   * is the only way data gets INTO the sandbox (spec decision 5). Production:
   * no — the production panel's restore route is the owner's mechanism there.
   */
  resetRoutes: boolean;
}

export const PROD_STAGED_RESTORE: StagedRestoreSeam = {
  label: "production",
  markerStem: "pending-restore",
  preSwapStem: "pre-restore",
  restoreRoute: true,
  resetRoutes: false,
};

export const SANDBOX_STAGED_RESTORE: StagedRestoreSeam = {
  label: "sandbox",
  markerStem: "pending-restore-sandbox",
  preSwapStem: "pre-restore-sandbox",
  restoreRoute: false,
  resetRoutes: true,
};

/**
 * A self-contained server domain (health, batches, parts, purchase-orders,
 * rma, audits, search, reports, ...). Each domain lives in its own folder
 * under `server/domains/<name>/` and exports a registration function.
 */
export interface Domain {
  name: string;
  register(app: Express, ctx: AppContext): void;
}
