import { randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type Database from "better-sqlite3";
import type { AppContext } from "../../domain.js";

/**
 * Roles per CONTEXT.md: Manager can do everything Tech can. "Admin" is a
 * third role that today carries EVERY manager power — the separation is in
 * name only, reserved for later functionality, so no feature logic may
 * branch on it directly.
 */
export type Role = "admin" | "manager" | "tech";

/**
 * The ONE manager-powers predicate: every check that used to compare
 * `role === "manager"` goes through this — an admin passes everywhere a
 * manager does. When admin grows its own powers, this is the seam that
 * changes; no call site re-compares literals.
 */
export function hasManagerPowers(role: Role): boolean {
  return role === "manager" || role === "admin";
}

export interface CurrentUser {
  id: number;
  email: string;
  role: Role;
}

declare module "express-serve-static-core" {
  interface Request {
    /**
     * The acting user, set by the auth domain's session middleware for every
     * `/api` request. Later domains read this — never re-resolve the session
     * themselves.
     */
    currentUser?: CurrentUser;
  }
}

/**
 * The session cookie's NAME comes from the context (`ctx.sessionCookie` —
 * prod "session", sandbox "sandbox_session"), so two instances in one
 * process never share session state. These helpers take the name explicitly;
 * there is no module-level default to fall back on.
 */

/**
 * Persistent login: browsers cap cookies at 400 days; the server-side
 * session row never expires, so "log in rarely" is as indefinite as the
 * browser allows.
 */
const SESSION_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

interface SessionUserRow {
  id: number;
  email: string;
  role: Role;
  active: number;
}

/** Parses the session cookie pair out of a raw Cookie header (no cookie-parser dependency). */
export function readSessionCookie(req: Request, cookieName: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals !== -1 && part.slice(0, equals).trim() === cookieName) {
      return part.slice(equals + 1).trim();
    }
  }
  return undefined;
}

export function setSessionCookie(res: Response, cookieName: string, token: string): void {
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS,
  });
}

export function clearSessionCookie(res: Response, cookieName: string): void {
  res.clearCookie(cookieName, { path: "/" });
}

/**
 * Resolves the acting user from the session cookie (when present) onto
 * `req.currentUser`. Never rejects — public login routes run through it too;
 * `requireSession` is what rejects.
 */
export function createSessionMiddleware(ctx: AppContext): RequestHandler {
  const selectUser = ctx.db.prepare(
    `SELECT u.id, u.email, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  );
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = readSessionCookie(req, ctx.sessionCookie);
    if (token) {
      const row = selectUser.get(token) as SessionUserRow | undefined;
      if (row && row.active === 1) {
        req.currentUser = { id: row.id, email: row.email, role: row.role };
      }
    }
    next();
  };
}

/** Rejects any request without a session. Attached once, router-wide, by the auth domain. */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.currentUser) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  next();
}

/** Rejects any request from a user without manager powers (manager or admin).
 * Later domains reuse this on their manager-only endpoints. */
export function requireManager(req: Request, res: Response, next: NextFunction): void {
  if (req.currentUser === undefined || !hasManagerPowers(req.currentUser.role)) {
    res.status(403).json({ error: "manager role required" });
    return;
  }
  next();
}

export function createSession(
  db: Database.Database,
  now: Date,
  userId: number,
  createdByToken?: string
): string {
  const token = randomToken();
  db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, created_by_token) VALUES (?, ?, ?, ?)"
  ).run(token, userId, now.toISOString(), createdByToken ?? null);
  return token;
}

export function deleteSession(db: Database.Database, token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

/** Random 256-bit hex token — used for both login links and session cookies. */
export function randomToken(): string {
  return randomBytes(32).toString("hex");
}
