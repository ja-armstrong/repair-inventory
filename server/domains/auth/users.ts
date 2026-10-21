import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { AppContext } from "../../domain.js";
import type { Clock } from "../../clock.js";
import { recordEvent } from "./events.js";
import { hasManagerPowers, requireManager, type Role } from "./session.js";

/**
 * User management: list, create, role change, deactivate — all
 * manager-only (techs are refused). Registered on the session-gated /api
 * router by the auth domain; every handler can rely on `req.currentUser`.
 */

/**
 * The email-domain allowlist: which email addresses may hold accounts. It is
 * configuration, not code — each shop deploys with its own domains — so it is
 * read from `ALLOWED_EMAIL_DOMAINS` at call time (comma-separated; a leading
 * `@` on each entry is optional). See `.env.example`.
 *
 * Read at call time, not import time, so the test harness can pin the env per
 * worker the same way it pins ADMIN_KEY around app creation.
 *
 * Loud failure (AGENTS.md): an unset or empty allowlist throws instead of
 * silently letting every address in — an empty allowlist must never mean
 * "allow everything".
 */
export function allowedEmailDomains(): string[] {
  const raw = process.env.ALLOWED_EMAIL_DOMAINS;
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      "ALLOWED_EMAIL_DOMAINS is not set: copy .env.example to .env and set it, e.g. ALLOWED_EMAIL_DOMAINS=@acme.co,@acme.com"
    );
  }
  const domains = [
    ...new Set(
      raw
        .split(",")
        .map((part) => part.trim().replace(/^@+/, "").toLowerCase())
        .filter(Boolean)
    ),
  ];
  if (domains.length === 0) {
    throw new Error("ALLOWED_EMAIL_DOMAINS is empty: name at least one email domain");
  }
  for (const domain of domains) {
    if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith(".") || domain.endsWith(".")) {
      throw new Error(`ALLOWED_EMAIL_DOMAINS contains an invalid domain: ${domain}`);
    }
  }
  return domains;
}

/** The 400 message naming the configured domains, e.g. "an @acme.co or @acme.com address". */
export function allowedEmailDomainsMessage(): string {
  const list = allowedEmailDomains().map((domain) => `@${domain}`);
  const quoted =
    list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}`;
  return `email must be an ${quoted} address`;
}

export function isAllowlistedEmail(email: string): boolean {
  const lower = email.toLowerCase();
  return allowedEmailDomains().some((domain) => lower.endsWith(`@${domain}`));
}

interface UserRow {
  id: number;
  email: string;
  role: Role;
  active: number;
  created_at: string;
}

function getUserRow(db: Database.Database, id: number): UserRow | undefined {
  return db
    .prepare("SELECT id, email, role, active, created_at FROM users WHERE id = ?")
    .get(id) as UserRow | undefined;
}

function countActiveManagerPowers(db: Database.Database): number {
  // Manager POWERS, not the literal role: an admin can manage users too, so
  // the last-guard counts every active role that hasManagerPowers covers.
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role IN ('manager', 'admin') AND active = 1")
    .get() as { n: number };
  return row.n;
}

function parseUserId(raw: string | string[] | undefined): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) {
    return undefined;
  }
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

const createUserSchema = z.object({
  email: z.email(),
  role: z.enum(["admin", "manager", "tech"]),
});

const roleChangeSchema = z.object({
  role: z.enum(["admin", "manager", "tech"]),
});

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

/** The serialized user shape, shared by both surfaces (the manager-gated API
 * and the admin panel read the same columns). */
export function serializeUserRow(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export type UserWriteResult =
  | { ok: true; user: UserRow }
  | { ok: false; http: number; message: string };

/**
 * The ONE user-creation core: the allowlist check, the duplicate refusal,
 * the insert, and the event. Both surfaces go through it — the manager-gated
 * API (actor = the signed-in manager) and the admin panel (actor = null; the
 * owner stands up the user base from the panel, including the first user —
 * there is no bootstrap manager to do it, see admin/index.ts).
 */
export function createUser(
  db: Database.Database,
  clock: Clock,
  actor: { id: number } | null,
  params: { email: string; role: Role }
): UserWriteResult {
  const email = params.email.toLowerCase();
  if (!isAllowlistedEmail(email)) {
    return { ok: false, http: 400, message: allowedEmailDomainsMessage() };
  }
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
    return { ok: false, http: 409, message: "a user with that email already exists" };
  }
  const create = db.transaction(() => {
    const result = db
      .prepare("INSERT INTO users (email, role, active, created_at) VALUES (?, ?, 1, ?)")
      .run(email, params.role, clock.now().toISOString());
    const id = Number(result.lastInsertRowid);
    recordEvent(db, clock, {
      entityType: "user",
      entityId: id,
      actorId: actor === null ? null : actor.id,
      action: "user.created",
      payload: {
        email,
        role: params.role,
        ...(actor === null ? { via: "admin panel" } : {}),
      },
    });
    return id;
  });
  const id = create();
  return { ok: true, user: getUserRow(db, id) as UserRow };
}

/**
 * The ONE role-change core: validation, the last-active-manager guard, the
 * guarded UPDATE, and the event. Both surfaces go through it — the
 * manager-gated API (actor = the signed-in manager) and the admin panel
 * (actor = null: the owner acts outside any user session, and the timeline
 * records the change with no actor plus `via: "admin panel"`).
 */
export function changeUserRole(
  db: Database.Database,
  clock: Clock,
  actor: { id: number } | null,
  params: { userId: number; role: Role }
): UserWriteResult {
  const row = getUserRow(db, params.userId);
  if (!row) {
    return { ok: false, http: 404, message: "no user with that id" };
  }
  if (row.role === params.role) {
    return { ok: true, user: row };
  }
  // Never strand the system without a user who can manage users (a manager
  // OR an admin — both carry the powers).
  if (hasManagerPowers(row.role) && row.active === 1 && countActiveManagerPowers(db) <= 1) {
    return { ok: false, http: 409, message: "cannot change the role of the last active manager" };
  }
  const change = db.transaction(() => {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(params.role, params.userId);
    recordEvent(db, clock, {
      entityType: "user",
      entityId: params.userId,
      actorId: actor === null ? null : actor.id,
      action: "user.role_changed",
      payload: {
        from: row.role,
        to: params.role,
        ...(actor === null ? { via: "admin panel" } : {}),
      },
    });
  });
  change();
  return { ok: true, user: getUserRow(db, params.userId) as UserRow };
}

/**
 * The ONE activation core: the same shape as the role change — deactivate
 * kills the user's sessions immediately; the last-active-manager guard
 * applies to deactivation only (activating never strands anyone). Both
 * surfaces (manager-gated API, admin panel) go through it.
 */
export function setUserActive(
  db: Database.Database,
  clock: Clock,
  actor: { id: number } | null,
  params: { userId: number; active: boolean }
): UserWriteResult {
  const row = getUserRow(db, params.userId);
  if (!row) {
    return { ok: false, http: 404, message: "no user with that id" };
  }
  if ((row.active === 1) === params.active) {
    return { ok: true, user: row };
  }
  if (!params.active && hasManagerPowers(row.role) && countActiveManagerPowers(db) <= 1) {
    return { ok: false, http: 409, message: "cannot deactivate the last active manager" };
  }
  const write = db.transaction(() => {
    db.prepare("UPDATE users SET active = ? WHERE id = ?").run(params.active ? 1 : 0, params.userId);
    if (!params.active) {
      // Deactivation is effective immediately: their sessions die with it.
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(params.userId);
    }
    recordEvent(db, clock, {
      entityType: "user",
      entityId: params.userId,
      actorId: actor === null ? null : actor.id,
      action: params.active ? "user.reactivated" : "user.deactivated",
      payload: {
        email: row.email,
        ...(actor === null ? { via: "admin panel" } : {}),
      },
    });
  });
  write();
  return { ok: true, user: getUserRow(db, params.userId) as UserRow };
}

export function registerUsersRoutes(api: Router, ctx: AppContext): void {
  const users = Router();

  users.get("/", requireManager, (_req, res) => {
    const rows = ctx.db
      .prepare("SELECT id, email, role, active, created_at FROM users ORDER BY id")
      .all() as UserRow[];
    res.json(rows.map(serializeUserRow));
  });

  users.post("/", requireManager, (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "email and role are required");
      return;
    }
    const result = createUser(ctx.db, ctx.clock, req.currentUser!, {
      email: parsed.data.email,
      role: parsed.data.role,
    });
    if (!result.ok) {
      res.status(result.http).json({ error: result.message });
      return;
    }
    res.status(201).json(serializeUserRow(result.user));
  });

  users.patch("/:id/role", requireManager, (req, res) => {
    const parsed = roleChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, "role must be admin, manager, or tech");
      return;
    }
    const id = parseUserId(req.params.id);
    if (id === undefined) {
      badRequest(res, "invalid user id");
      return;
    }
    const result = changeUserRole(ctx.db, ctx.clock, req.currentUser!, {
      userId: id,
      role: parsed.data.role,
    });
    if (!result.ok) {
      res.status(result.http).json({ error: result.message });
      return;
    }
    res.json(serializeUserRow(result.user));
  });

  users.post("/:id/deactivate", requireManager, (req, res) => {
    const id = parseUserId(req.params.id);
    if (id === undefined) {
      badRequest(res, "invalid user id");
      return;
    }
    const result = setUserActive(ctx.db, ctx.clock, req.currentUser!, {
      userId: id,
      active: false,
    });
    if (!result.ok) {
      res.status(result.http).json({ error: result.message });
      return;
    }
    res.json(serializeUserRow(result.user));
  });

  api.use("/users", users);
}
