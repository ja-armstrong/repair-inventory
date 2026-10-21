import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import type { Express } from "express";
import { z } from "zod";
import type { AppContext, Domain } from "../../domain.js";
import { LOGIN_LINK_TTL_MS, buildLoginLinkUrl } from "../auth/index.js";
import { recordEvent } from "../auth/events.js";
import {
  changeUserRole,
  createUser,
  serializeUserRow,
  setUserActive,
} from "../auth/users.js";
import { hasManagerPowers, type Role, randomToken } from "../auth/session.js";
import { getSetting, SETTING_DEFINITIONS, validateSettingValue } from "../parts/settings.js";
import { createSession, deleteSession } from "../auth/session.js";
import {
  ENV_CATALOG,
  envValues,
  maskSecret,
  readEnvFile,
  withEnvValue,
  writeEnvFile,
} from "./envfile.js";
import {
  MAX_RESTORE_UPLOAD_BYTES,
  backupsDirOf,
  createBackup,
  fileStamp,
  pendingRestoreMarkerPath,
  validateBackupFile,
  wipeAndRecreate,
} from "./backups.js";
import { registerSandboxResetRoutes } from "./reset.js";
import { runSelect, singleStatement } from "./sql.js";
import {
  adminKeyMatches,
  clearAdminCookie,
  createFailureLimiter,
  readCookie,
  requireAdmin,
  setAdminCookie,
} from "./auth.js";

/**
 * The admin domain (ticket 18): the owner's separate surface — settings,
 * backups, restore, clear, a guarded SQL console, and system info — under
 * `/api/admin`, with its own key-based auth (ADMIN_KEY from the environment,
 * held in a dedicated `admin_session` cookie). Main-app sessions grant
 * nothing here: this domain never reads the session cookie.
 *
 * When ADMIN_KEY is unset the entire surface is disabled: every /api/admin
 * route answers 404 (indistinguishable from a route that does not exist),
 * and the production entrypoint logs a loud warning at startup.
 *
 * Danger rules (per AGENTS.md): every destructive action — clear, restore
 * swap, write-mode SQL — is backed up first, typed-confirmed, and
 * console-logged with a timestamp. The mechanics live in `backups.ts` and
 * `sql.ts`; this file is the HTTP edge. Ticket 22 adds the .env editor
 * (`envfile.ts`), the restart button behind an explicit supervision gate,
 * and the API console that self-dispatches requests as the bootstrap
 * manager through the app's own routes. The sandbox instance (sandbox
 * tickets 04–05) registers the same panel against the sandbox database:
 * its backup/clear/console tools are instance-seamed, its stock restore
 * route is replaced by the sandbox reset surface (`reset.ts`), and each
 * instance's staged swap lives in its own staging slot.
 */

/** The exact phrase the owner must type to clear the database. */
export const CLEAR_CONFIRMATION_PHRASE = "ERASE ALL DATA";

/** The exact phrase the owner must type to enable SQL write mode. */
export const WRITE_MODE_CONFIRMATION_PHRASE = "ALLOW WRITES";

/** The exact phrase the owner must type to restart the server (ticket 22). */
export const RESTART_CONFIRMATION_PHRASE = "RESTART";

/** Respond-then-exit: the response is flushed before the process exits. */
export const RESTART_EXIT_DELAY_MS = 300;

/**
 * The explicit supervision gate for the restart button (ticket 22): restart
 * means `process.exit(0)`, so the ONLY question is who starts the process
 * again. `npm run dev` runs `tsx watch`, which restarts the child on exit —
 * restarting is safe and expected there. `npm start` has no watch: exiting
 * stops the server until a human acts. ALLOW_RESTART=true is the owner's
 * explicit acknowledgment that a supervisor (NSSM service, scheduled task
 * with restart, pm2) will bring the process back. The gate is read at
 * request time so the UI can display the state it will act on.
 */
export interface RestartGate {
  allowed: boolean;
  mode: "dev" | "supervised" | "refused";
  explanation: string;
}

export function restartGate(): RestartGate {
  if (process.env.npm_lifecycle_event === "dev") {
    return {
      allowed: true,
      mode: "dev",
      explanation:
        "the server runs under npm run dev (tsx watch), which starts it again the moment it exits",
    };
  }
  if ((process.env.ALLOW_RESTART ?? "").trim().toLowerCase() === "true") {
    return {
      allowed: true,
      mode: "supervised",
      explanation:
        "ALLOW_RESTART=true acknowledges the server runs under a supervisor (a service or process manager) that starts it again after it exits",
    };
  }
  return {
    allowed: false,
    mode: "refused",
    explanation:
      "npm start has no supervisor: if the server exits now, nothing starts it again until a person does. Restart by hand, or run the server under a supervisor (an NSSM service, a scheduled task with restart, pm2) and set ALLOW_RESTART=true in .env to acknowledge that.",
  };
}

/** Brute-force blunting: at most 5 failed key attempts per minute per IP. */
const MAX_FAILED_ATTEMPTS = 5;
const FAILED_ATTEMPT_WINDOW_MS = 60_000;

const APP_VERSION: string = (
  JSON.parse(
    fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
  ) as { version: string }
).version;

const loginSchema = z.object({ key: z.string() });
const confirmationSchema = z.object({ confirmation: z.string() });
const patchSettingSchema = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number()]),
});
const sqlSchema = z.object({
  sql: z.string().min(1),
  allowWrite: z.boolean().optional(),
});
const envPutSchema = z.object({ key: z.string(), value: z.string() });
const apiConsoleSchema = z.object({
  method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
  path: z.string().min(1),
  body: z.unknown().optional(),
});

function logAdmin(message: string): void {
  console.log(`[admin] ${new Date().toISOString()} ${message}`);
}

function logSql(sql: string): void {
  logAdmin(`sql executed: ${sql}`);
}

interface TableRow {
  name: string;
}

/** Builds the masked .env state shown to the admin UI (ticket 22). */
function envStateJson(ctx: AppContext) {
  const file = readEnvFile();
  const values = envValues(file.lines);
  const entries = ENV_CATALOG.map((entry) => {
    const fileValue = values.get(entry.key);
    // Pending-restart honesty: the flag is a boolean only — the file value is
    // never sent alongside the live value, so nothing sensitive leaks. Live
    // values come from process.env (loaded from this same file at startup).
    const pendingRestart = (fileValue ?? "") !== (process.env[entry.key] ?? "");
    // Editable rows show the FILE value (the editing target). Read-only rows
    // show the LIVE effective value — what the server is actually running
    // with right now — because they cannot be edited from the panel.
    const liveDefaults: Record<string, string> = { DB_PATH: "data/repair-inventory.sqlite", PORT: "3000" };
    const value = entry.editable
      ? (entry.secret ? maskSecret(fileValue) : (fileValue ?? ""))
      : (process.env[entry.key] ?? liveDefaults[entry.key] ?? "");
    return {
      key: entry.key,
      description: entry.description,
      editable: entry.editable,
      secret: entry.secret,
      reason: entry.reason ?? null,
      value,
      pendingRestart,
    };
  });
  return {
    file: { path: file.path, exists: file.exists },
    entries,
    restartRequired: entries.some((entry) => entry.pendingRestart),
    note: "Changes made here take effect only when the server is restarted.",
    // Which database THIS panel governs, resolved by the composition root —
    // read-only facts, never editable here. The sandbox trainer must be able
    // to see exactly which file the sandbox is (sandbox ticket 04); prod
    // shows its own, so the page always names its target.
    instance: { dbPath: ctx.dbPath, mountPrefix: ctx.mountPrefix },
  };
}

export const adminDomain: Domain = {
  name: "admin",
  register(app: Express, ctx: AppContext) {
    const adminKey = process.env.ADMIN_KEY?.trim() ?? "";
    if (!adminKey) {
      // Disabled surface: answer 404 for every method on every /api/admin
      // path, revealing nothing — not even that the panel exists. The loud
      // startup warning lives in the production entrypoint (server/index.ts).
      app.use("/api/admin", (_req, res) => {
        res.status(404).json({ error: "not found" });
      });
      return;
    }

    // Admin-session tokens live only in this process's memory: a restart
    // invalidates them and the key must be entered again.
    const tokens = new Set<string>();
    const writeModeSessions = new Set<string>();
    const failedLogins = createFailureLimiter(MAX_FAILED_ATTEMPTS, FAILED_ATTEMPT_WINDOW_MS);
    const requireAdminSession = requireAdmin(tokens, ctx.adminCookie);

    const router = Router();

    // ---- admin session (the key door) ------------------------------------

    router.post("/session", (req, res) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "the admin key is required" });
        return;
      }
      const ip = req.ip ?? "unknown";
      const now = Date.now();
      if (!failedLogins.allows(ip, now)) {
        res.status(429).json({ error: "too many failed attempts; wait a minute and try again" });
        return;
      }
      if (!adminKeyMatches(parsed.data.key, adminKey)) {
        failedLogins.record(ip, now);
        // No detail beyond "wrong": not whether the key is close, not how
        // many attempts remain.
        res.status(401).json({ error: "invalid admin key" });
        return;
      }
      const token = randomToken();
      tokens.add(token);
      setAdminCookie(res, ctx.adminCookie, token);
      logAdmin("admin session opened");
      res.status(204).end();
    });

    router.get("/session", requireAdminSession, (_req, res) => {
      res.json({ ok: true });
    });

    router.delete("/session", requireAdminSession, (req, res) => {
      tokens.delete(req.adminToken!);
      clearAdminCookie(res, ctx.adminCookie);
      res.status(204).end();
    });

    // ---- user & role management --------------------------------------------
    //
    // The owner's surface for the user base itself: list, create, change
    // roles, deactivate/reactivate, and mint login links. Every write goes
    // through the auth domain's ONE cores (createUser / changeUserRole /
    // setUserActive) with actor = null — the owner acts outside any user
    // session, and the timeline records the change with no actor plus
    // `via: "admin panel"`. This is also the bootstrap path now: a fresh or
    // wiped database has zero users, and the owner stands them up here
    // (there is no auto-provisioned manager to do it).

    const listUsers = () =>
      (
        ctx.db
          .prepare("SELECT id, email, role, active, created_at FROM users ORDER BY id")
          .all() as UserRowLike[]
      ).map(serializeUserRow);

    interface UserRowLike {
      id: number;
      email: string;
      role: Role;
      active: number;
      created_at: string;
    }

    router.get("/users", requireAdminSession, (_req, res) => {
      res.json({ users: listUsers() });
    });

    const adminCreateUserSchema = z.object({
      email: z.email(),
      role: z.enum(["admin", "manager", "tech"]),
    });

    router.post("/users", requireAdminSession, (req, res) => {
      const parsed = adminCreateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "a valid email and a role (admin, manager, or tech) are required" });
        return;
      }
      const result = createUser(ctx.db, ctx.clock, null, parsed.data);
      if (!result.ok) {
        res.status(result.http).json({ error: result.message });
        return;
      }
      logAdmin(`user created via admin panel: ${parsed.data.email} (${parsed.data.role})`);
      res.status(201).json({ user: serializeUserRow(result.user), users: listUsers() });
    });

    const adminRoleSchema = z.object({
      role: z.enum(["admin", "manager", "tech"]),
    });

    router.patch("/users/:id/role", requireAdminSession, (req, res) => {
      const parsed = adminRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "role must be admin, manager, or tech" });
        return;
      }
      const id = parseAdminUserId(req.params.id);
      if (id === undefined) {
        res.status(400).json({ error: "invalid user id" });
        return;
      }
      const result = changeUserRole(ctx.db, ctx.clock, null, { userId: id, role: parsed.data.role });
      if (!result.ok) {
        res.status(result.http).json({ error: result.message });
        return;
      }
      logAdmin(`role changed via admin panel: user ${id} is now ${parsed.data.role}`);
      res.json({ user: serializeUserRow(result.user), users: listUsers() });
    });

    const adminActiveSchema = z.object({
      active: z.boolean(),
    });

    router.patch("/users/:id/active", requireAdminSession, (req, res) => {
      const parsed = adminActiveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "an active boolean is required" });
        return;
      }
      const id = parseAdminUserId(req.params.id);
      if (id === undefined) {
        res.status(400).json({ error: "invalid user id" });
        return;
      }
      const result = setUserActive(ctx.db, ctx.clock, null, { userId: id, active: parsed.data.active });
      if (!result.ok) {
        res.status(result.http).json({ error: result.message });
        return;
      }
      logAdmin(`user ${id} ${parsed.data.active ? "reactivated" : "deactivated"} via admin panel`);
      res.json({ user: serializeUserRow(result.user), users: listUsers() });
    });

    // Mints a login link for an EXISTING user: the login flow needs an
    // existing account, so this is how a panel-created user gets in (and how
    // anyone gets back in when the email plug is not configured). The link
    // is delivered through the app's email plug AND returned in the
    // response — the admin key holder may need to hand it over directly.
    const adminLoginLinkSchema = z.object({
      origin: z.string().trim().optional(),
    });

    router.post("/users/:id/login-link", requireAdminSession, async (req, res) => {
      const parsed = adminLoginLinkSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "a body is required (it may be empty)" });
        return;
      }
      const id = parseAdminUserId(req.params.id);
      if (id === undefined) {
        res.status(400).json({ error: "invalid user id" });
        return;
      }
      const user = ctx.db
        .prepare("SELECT id, email, active FROM users WHERE id = ?")
        .get(id) as { id: number; email: string; active: number } | undefined;
      if (!user) {
        res.status(404).json({ error: "no user with that id" });
        return;
      }
      if (user.active !== 1) {
        res.status(409).json({ error: "that user is deactivated — reactivate them first" });
        return;
      }
      const now = ctx.clock.now();
      const expiresAt = new Date(now.getTime() + LOGIN_LINK_TTL_MS);
      const token = randomToken();
      ctx.db
        .prepare(
          "INSERT INTO login_tokens (token, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)"
        )
        .run(token, user.id, now.toISOString(), expiresAt.toISOString());
      // The same origin rule as the public login flow, and the same link
      // builder: the panel request's Origin (same host) wins, APP_ORIGIN is
      // the fallback, and the context's mount prefix is part of the path.
      const loginUrl = buildLoginLinkUrl(req, ctx, token, parsed.data.origin);
      try {
        await ctx.emailPlug.sendLoginLink(user.email, loginUrl, expiresAt);
      } catch {
        // Delivery failure is fine — the link is in the response either way.
      }
      logAdmin(`login link minted via admin panel for ${user.email}`);
      res.status(201).json({
        loginUrl,
        expiresAt: expiresAt.toISOString(),
        delivered: true,
        note:
          "The link expires in 15 minutes. If the app's email is configured it was also sent; otherwise hand this link to the user.",
      });
    });

    function parseAdminUserId(raw: string | string[] | undefined): number | undefined {
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (value === undefined) {
        return undefined;
      }
      const id = Number(value);
      return Number.isInteger(id) && id > 0 ? id : undefined;
    }

    // ---- global settings ---------------------------------------------------

    const settingsJson = () => ({
      settings: SETTING_DEFINITIONS.map((definition) => ({
        key: definition.key,
        value: getSetting(ctx.db, definition.key),
        // Ticket 19: text settings have no minimum — null renders as an
        // empty Minimum column instead of a misleading number.
        min: definition.min ?? null,
        default: definition.default,
      })),
    });

    router.get("/settings", requireAdminSession, (_req, res) => {
      res.json(settingsJson());
    });

    router.patch("/settings", requireAdminSession, (req, res) => {
      const parsed = patchSettingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "a settings key and value are required" });
        return;
      }
      const { key, value } = parsed.data;
      const definition = SETTING_DEFINITIONS.find((candidate) => candidate.key === key);
      if (!definition) {
        res.status(400).json({ error: `unknown setting: ${key}` });
        return;
      }
      // The same validation rule the manager settings route enforces
      // (settings.ts validateSettingValue is the single source); a bad value
      // is refused with the reason, never coerced.
      const validated = validateSettingValue(definition, value);
      if ("error" in validated) {
        res.status(400).json({ error: validated.error });
        return;
      }
      const validatedValue = validated.value;
      const previous = getSetting(ctx.db, key);
      const update = ctx.db.transaction(() => {
        // Rows are seeded by migration 0003; this insert only guards a
        // database that predates the seed (same as the manager route).
        const existing = ctx.db
          .prepare("SELECT id FROM app_settings WHERE key = ?")
          .get(key) as { id: number } | undefined;
        if (!existing) {
          const inserted = ctx.db
            .prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .run(key, definition.default);
          recordEvent(ctx.db, ctx.clock, {
            entityType: "setting",
            entityId: Number(inserted.lastInsertRowid),
            actorId: null,
            action: "setting.created",
            payload: { key, value: definition.default },
          });
        }
        ctx.db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(String(validatedValue), key);
        const row = ctx.db
          .prepare("SELECT id FROM app_settings WHERE key = ?")
          .get(key) as { id: number };
        // The admin is not an app user, so the event is actor-less (system).
        recordEvent(ctx.db, ctx.clock, {
          entityType: "setting",
          entityId: row.id,
          actorId: null,
          action: "setting.updated",
          payload: { key, from: previous, to: String(validatedValue), via: "admin" },
        });
      });
      update();
      res.json(settingsJson());
    });

    // ---- .env editor (ticket 22) ------------------------------------------
    //
    // Reads and writes <project root>/.env (or the RMS_ENV_FILE override).
    // Every response carries restart-required honesty: .env values are loaded
    // once at startup, so nothing saved here affects the running process.

    router.get("/env", requireAdminSession, (_req, res) => {
      res.json(envStateJson(ctx));
    });

    router.put("/env", requireAdminSession, (req, res) => {
      const parsed = envPutSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "an environment key and value are required" });
        return;
      }
      const { key, value } = parsed.data;
      const entry = ENV_CATALOG.find((candidate) => candidate.key === key);
      if (!entry) {
        res.status(400).json({
          error: `unknown environment key: ${key} — this editor manages only the catalogued keys`,
        });
        return;
      }
      if (!entry.editable) {
        res.status(400).json({ error: `${key} is ${entry.reason}` });
        return;
      }
      // Secret protection: an empty submission is a no-op, never an accidental
      // wipe of the stored key (clearing ADMIN_KEY would disable the panel).
      if (entry.secret && value.trim() === "") {
        res.json({
          ok: true,
          changed: false,
          key,
          message: `${key} was left unchanged — an empty value for a secret means no change.`,
          ...envStateJson(ctx),
        });
        return;
      }
      const file = readEnvFile();
      let nextLines;
      try {
        nextLines = withEnvValue(file.lines, key, value);
      } catch (error) {
        res.status(400).json({ error: (error as Error).message });
        return;
      }
      writeEnvFile(file.path, nextLines);
      // Log only the KEY, never the value of a secret.
      logAdmin(`env changed: ${key} (takes effect at the next restart)`);
      res.json({
        ok: true,
        changed: true,
        key,
        message: `${key} saved. It takes effect only when the server is restarted.`,
        // restartRequired comes from envStateJson(), computed from the file
        // vs the live process.env — always true right after a real change.
        ...envStateJson(ctx),
      });
    });

    // ---- backup download (one click) --------------------------------------

    router.get("/backup", requireAdminSession, async (_req, res) => {
      const backup = await createBackup(ctx.db, ctx.dbPath, ctx.clock, ctx.backupStem);
      logAdmin(`backup created: ${backup.path}`);
      // Saved to data/backups AND streamed as a timestamped download.
      res.download(backup.path, backup.filename);
    });

    // ---- clear the database (danger zone) ---------------------------------

    router.post("/clear", requireAdminSession, async (req, res) => {
      const parsed = confirmationSchema.safeParse(req.body);
      if (!parsed.success || parsed.data.confirmation.trim() !== CLEAR_CONFIRMATION_PHRASE) {
        res
          .status(400)
          .json({ error: `type "${CLEAR_CONFIRMATION_PHRASE}" to confirm clearing the database` });
        return;
      }
      // Danger rule ordering: backup FIRST, then destroy.
      const backup = await createBackup(ctx.db, ctx.dbPath, ctx.clock, ctx.backupStem);
      wipeAndRecreate(ctx.db, ctx.clock);
      logAdmin(
        `DATABASE CLEARED at the owner's request — every table dropped and recreated; ` +
          `pre-wipe backup: ${backup.path}`
      );
      // A wiped database has ZERO users — and that is not a locked one: the
      // owner holds the ADMIN_KEY, and the Users section of this panel
      // creates users and mints their first login links (the login flow
      // needs an existing user; there is no bootstrap manager anymore).
      res.json({
        ok: true,
        backup: backup.filename,
        note: "Every user was erased with the database. Create your users in the Users section of this panel, then send each one their login link.",
      });
    });

    // ---- restore from backup (danger zone) --------------------------------
    //
    // Staged, never swapped in-process (see backups.ts): the upload is
    // validated, the current database is backed up, and the file swap happens
    // at the next server start.
    //
    // This stock route registers ONLY where the instance seam says so
    // (AppContext.stagedRestore.restoreRoute): production. The sandbox's
    // reset routes (below /reset, sandbox ticket 05) supersede it there —
    // they stage into the sandbox's OWN slot, and leaving a second route
    // that stages into the shared-marker slot of old would have let a
    // sandbox restore be swapped into the PRODUCTION database at startup.

    if (ctx.stagedRestore.restoreRoute) {
      router.post(
        "/restore",
        requireAdminSession,
        express.raw({ type: "application/octet-stream", limit: MAX_RESTORE_UPLOAD_BYTES }),
        async (req, res) => {
          const body = req.body;
          if (!Buffer.isBuffer(body) || body.length === 0) {
            res.status(400).json({
              error: "upload the .sqlite file as the raw request body (application/octet-stream)",
            });
            return;
          }
          const originalName = typeof req.query.filename === "string" ? req.query.filename : "";
          if (!/\.sqlite$/i.test(originalName)) {
            res.status(400).json({ error: "the uploaded file must be named *.sqlite" });
            return;
          }
          fs.mkdirSync(backupsDirOf(ctx.dbPath), { recursive: true });
          const stamp = fileStamp(ctx.clock.now());
          const uploadPath = path.join(backupsDirOf(ctx.dbPath), `restore-upload-${stamp}.sqlite`);
          fs.writeFileSync(uploadPath, body);
          const validation = validateBackupFile(uploadPath);
          if (!validation.ok) {
            fs.rmSync(uploadPath, { force: true });
            res.status(400).json({ error: validation.error });
            return;
          }
          // Danger rule: the CURRENT database is backed up before anything
          // moves, so even a mistaken restore is undoable.
          const backup = await createBackup(ctx.db, ctx.dbPath, ctx.clock, ctx.backupStem);
          // The staged name and the marker file come from this instance's
          // staging slot (prod: "pending-restore") — one slot per instance,
          // so the startup swap (applyPendingRestore) can never cross the
          // two instances' staged files.
          const stagedName = `${ctx.stagedRestore.markerStem}-${stamp}.sqlite`;
          fs.renameSync(uploadPath, path.join(backupsDirOf(ctx.dbPath), stagedName));
          const marker = {
            file: stagedName,
            requestedAt: ctx.clock.now().toISOString(),
            backup: backup.filename,
          };
          fs.writeFileSync(
            pendingRestoreMarkerPath(ctx.dbPath, ctx.stagedRestore.markerStem),
            JSON.stringify(marker, null, 2)
          );
          logAdmin(
            `restore staged: ${stagedName} — current database backed up as ${backup.filename}; ` +
              `restart the server to complete the swap`
          );
          res.json({
            ok: true,
            backup: backup.filename,
            staged: stagedName,
            restartRequired: true,
          });
        }
      );
    } else {
      // The route is deliberately ABSENT on this instance, and the 404 is
      // explicit: without this tombstone an unmatched /api/admin path would
      // fall through to the main app's session gate and answer a misleading
      // 401 — the removed route must read as nonexistent, like the whole
      // disabled surface does.
      router.post("/restore", (_req, res) => {
        res.status(404).json({ error: "not found" });
      });
    }

    // ---- sandbox reset (sandbox ticket 05) ---------------------------------
    //
    // Registers only where the instance seam says so
    // (AppContext.stagedRestore.resetRoutes): the sandbox. Manual only — no
    // schedule, no auto-reset; a scheduler here would be a defect.

    if (ctx.stagedRestore.resetRoutes) {
      registerSandboxResetRoutes(router, ctx, requireAdminSession);
    }

    // ---- restart the server (ticket 22) -----------------------------------
    //
    // Responds first, then exits. Whether exiting is allowed is decided ONLY
    // by the supervision gate (restartGate above) — never guessed.

    router.get("/restart", requireAdminSession, (_req, res) => {
      res.json(restartGate());
    });

    router.post("/restart", requireAdminSession, (req, res) => {
      const parsed = confirmationSchema.safeParse(req.body);
      if (!parsed.success || parsed.data.confirmation.trim() !== RESTART_CONFIRMATION_PHRASE) {
        res
          .status(400)
          .json({ error: `type "${RESTART_CONFIRMATION_PHRASE}" to confirm restarting the server` });
        return;
      }
      const gate = restartGate();
      if (!gate.allowed) {
        res.status(409).json({ error: gate.explanation, mode: gate.mode });
        return;
      }
      logAdmin(
        `RESTART requested from the admin panel (mode: ${gate.mode}) — exiting in ${RESTART_EXIT_DELAY_MS}ms. ` +
          `Admin sessions end (in memory); main-app sessions survive (in the database).`
      );
      res.json({
        ok: true,
        mode: gate.mode,
        message:
          "The server is exiting now. Once it comes back, the admin sessions have ended — " +
          "sign in again with the admin key. Main-app users stay logged in.",
      });
      setTimeout(() => process.exit(0), RESTART_EXIT_DELAY_MS);
    });

    // ---- SQL console -------------------------------------------------------

    router.get("/sql/write-mode", requireAdminSession, (req, res) => {
      res.json({ writeMode: writeModeSessions.has(req.adminToken!) });
    });

    router.post("/sql/write-mode", requireAdminSession, (req, res) => {
      const parsed = confirmationSchema.safeParse(req.body);
      if (!parsed.success || parsed.data.confirmation.trim() !== WRITE_MODE_CONFIRMATION_PHRASE) {
        res.status(400).json({
          error: `type "${WRITE_MODE_CONFIRMATION_PHRASE}" to enable writes for this session`,
        });
        return;
      }
      writeModeSessions.add(req.adminToken!);
      logAdmin("SQL write mode ENABLED for this admin session");
      res.json({ writeMode: true });
    });

    router.delete("/sql/write-mode", requireAdminSession, (req, res) => {
      writeModeSessions.delete(req.adminToken!);
      logAdmin("SQL write mode disabled for this admin session");
      res.json({ writeMode: false });
    });

    router.post("/sql", requireAdminSession, async (req, res) => {
      const parsed = sqlSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "an sql string is required" });
        return;
      }
      const sql = parsed.data.sql.trim();
      if (sql === "") {
        res.status(400).json({ error: "an SQL statement is required" });
        return;
      }
      if (!parsed.data.allowWrite) {
        // Read-only default: exactly one SELECT statement, nothing else.
        const statement = singleStatement(sql);
        if (statement === undefined) {
          res
            .status(400)
            .json({ error: "run one statement at a time (no chained statements)" });
          return;
        }
        if (!/^select\b/i.test(statement)) {
          res.status(400).json({
            error:
              "read-only console: only SELECT statements run — enable write mode (with the confirmation phrase) for anything else",
          });
          return;
        }
        logSql(statement);
        try {
          res.json(runSelect(ctx.db, statement));
        } catch (error) {
          res.status(400).json({ error: (error as Error).message });
        }
        return;
      }
      if (!writeModeSessions.has(req.adminToken!)) {
        res.status(403).json({
          error: `write mode is off for this admin session — enable it first by typing "${WRITE_MODE_CONFIRMATION_PHRASE}"`,
        });
        return;
      }
      const statement = singleStatement(sql);
      const readOnlyStatement =
        statement !== undefined && /^select\b/i.test(statement);
      // Automatic pre-write backup for anything that can change data. A
      // single SELECT in write mode reads only, so it needs no backup.
      let backupFilename: string | undefined;
      if (!readOnlyStatement) {
        const backup = await createBackup(ctx.db, ctx.dbPath, ctx.clock, ctx.backupStem);
        backupFilename = backup.filename;
        logAdmin(`pre-write backup: ${backup.path}`);
      }
      logSql(sql);
      try {
        if (statement === undefined) {
          ctx.db.exec(sql);
          res.json({ ok: true, backup: backupFilename });
          return;
        }
        const prepared = ctx.db.prepare(statement);
        if (prepared.reader) {
          res.json({ ...runSelect(ctx.db, statement), backup: backupFilename });
        } else {
          const info = prepared.run();
          res.json({ changes: info.changes, backup: backupFilename });
        }
      } catch (error) {
        // Errors verbatim — this console exists to inspect and fix data.
        res.status(400).json({ error: (error as Error).message });
      }
    });

    // ---- API console (ticket 22) -------------------------------------------
    //
    // Dispatches a real HTTP request against this same app so the owner can
    // drive the production API from the panel. Unlike the SQL console (which
    // writes straight to the database), every mutation here flows through the
    // app's own routes, validation, and timeline events — no invariant is
    // bypassed. The request runs AS the bootstrap manager: the console
    // creates a real session row through the existing session seam and
    // attaches it as the main app's session cookie. The dispatch URL carries
    // the context's mount prefix: in the sandbox the request must land on the
    // SANDBOX app (mounted at /sandbox on the shared listener) — without the
    // prefix, "/api/..." would hit the production app with a sandbox cookie
    // and operate the wrong database.

    router.post("/api-console", requireAdminSession, async (req, res) => {
      const parsed = apiConsoleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "a method (GET, POST, PATCH, PUT, or DELETE) and a same-app path are required",
        });
        return;
      }
      const { method } = parsed.data;
      const target = parsed.data.path;
      if (parsed.data.body !== undefined &&
          (typeof parsed.data.body !== "object" || parsed.data.body === null || Array.isArray(parsed.data.body))) {
        res.status(400).json({ error: "the body must be a JSON object" });
        return;
      }
      // Same-app guard: only this application's own endpoints may be called.
      if (!/^\/api(\/|$)/.test(target) && target !== "/health") {
        res.status(400).json({
          error: `only same-app paths can be dispatched: /api/... or /health — got ${target}`,
        });
        return;
      }
      if (target.includes("..")) {
        res.status(400).json({ error: "the path must not contain '..'" });
        return;
      }
      // The console runs AS a real manager-powers user: the FIRST active
      // one by id. There is no bootstrap manager anymore — if the owner
      // wiped the database, the Users section creates one first.
      const actor = ctx.db
        .prepare(
          "SELECT id, email FROM users WHERE active = 1 AND role IN ('manager', 'admin') ORDER BY id LIMIT 1"
        )
        .get() as { id: number; email: string } | undefined;
      if (!actor) {
        res.status(400).json({
          error:
            "no active manager or admin exists — create one in the Users section of this panel first; the console has nobody to run as",
        });
        return;
      }
      const token = createSession(ctx.db, ctx.clock.now(), actor.id);
      try {
        const port = Number(process.env.PORT ?? 3000);
        const headers: Record<string, string> = { cookie: `${ctx.sessionCookie}=${token}` };
        let bodyText: string | undefined;
        if (parsed.data.body !== undefined) {
          headers["content-type"] = "application/json";
          bodyText = JSON.stringify(parsed.data.body);
        }
        const response = await fetch(`http://127.0.0.1:${port}${ctx.mountPrefix}${target}`, {
          method,
          headers,
          body: bodyText,
          // Passthrough honesty: a redirect is shown as-is, not silently followed.
          redirect: "manual",
        });
        const text = await response.text();
        let responseBody: unknown;
        try {
          responseBody = JSON.parse(text);
        } catch {
          responseBody = text;
        }
        logAdmin(`api-console: ${method} ${target} → ${response.status} (as ${actor.email})`);
        res.json({
          status: response.status,
          headers: {
            "content-type": response.headers.get("content-type"),
            "content-disposition": response.headers.get("content-disposition"),
          },
          body: responseBody,
        });
      } catch (error) {
        res.status(502).json({
          error: `could not reach this server at 127.0.0.1:${process.env.PORT ?? 3000} — ${(error as Error).message}`,
        });
      } finally {
        deleteSession(ctx.db, token);
      }
    });

    // ---- system info -------------------------------------------------------

    router.get("/system", requireAdminSession, (_req, res) => {
      const tables = (
        ctx.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
          )
          .all() as TableRow[]
      ).map(({ name }) => ({
        name,
        rows: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as {
          n: number;
        }).n,
      }));
      const migrations = ctx.db
        .prepare("SELECT name, applied_at FROM migrations ORDER BY name")
        .all() as Array<{ name: string; applied_at: string }>;
      res.json({
        tables,
        migrations,
        uptimeSeconds: process.uptime(),
        dbPath: ctx.dbPath,
        dbSizeBytes: fs.existsSync(ctx.dbPath) ? fs.statSync(ctx.dbPath).size : null,
        backupsDirectory: backupsDirOf(ctx.dbPath),
        nodeVersion: process.version,
        appVersion: APP_VERSION,
      });
    });

    app.use("/api/admin", router);
  },
};
