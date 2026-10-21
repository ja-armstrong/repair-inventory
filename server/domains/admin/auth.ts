import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

declare module "express-serve-static-core" {
  interface Request {
    /**
     * The admin-session token, set by requireAdmin for every authenticated
     * /api/admin request. Per-session state (the SQL console's write mode)
     * is keyed by it.
     */
    adminToken?: string;
  }
}

/**
 * The admin surface's own authentication (ticket 18): a shared `ADMIN_KEY`
 * from the environment, entered once and held in a dedicated admin-session
 * cookie — deliberately a different cookie from the main app's session. The
 * cookie NAME comes from the context (`ctx.adminCookie` — prod
 * "admin_session", sandbox "sandbox_admin_session"), so the two instances'
 * admin panels never share a session. Main-app sessions grant nothing here:
 * this middleware never reads the session cookie and never resolves a user.
 * Tokens live only in the server process's memory, so a restart requires
 * re-entering the key.
 */

/** Persistent like the main session: the browser caps cookies at 400 days. */
const ADMIN_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

/** Parses one cookie value out of a raw Cookie header (no cookie-parser dependency). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const equals = part.indexOf("=");
    if (equals !== -1 && part.slice(0, equals).trim() === name) {
      return part.slice(equals + 1).trim();
    }
  }
  return undefined;
}

/**
 * Constant-time key comparison: both sides are hashed to fixed-length
 * digests first, so timing leaks nothing and length differences are safe.
 */
export function adminKeyMatches(provided: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

export function setAdminCookie(res: Response, cookieName: string, token: string): void {
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: ADMIN_MAX_AGE_MS,
  });
}

export function clearAdminCookie(res: Response, cookieName: string): void {
  res.clearCookie(cookieName, { path: "/" });
}

/**
 * Failed-login rate limiter (blunt brute-force defense): per client IP, at
 * most `max` failed attempts per rolling `windowMs` — successes never count.
 * In-memory by design; a restart clears it, and that is acceptable for a
 * single-shop prototype.
 */
export interface FailureLimiter {
  /** Whether another attempt from this key is allowed right now. */
  allows(key: string, now: number): boolean;
  /** Records one failure against this key. */
  record(key: string, now: number): void;
}

export function createFailureLimiter(max: number, windowMs: number): FailureLimiter {
  const failures = new Map<string, number[]>();
  return {
    allows(key, now) {
      const recent = (failures.get(key) ?? []).filter((at) => now - at < windowMs);
      if (recent.length > 0) {
        failures.set(key, recent);
      } else {
        failures.delete(key);
      }
      return recent.length < max;
    },
    record(key, now) {
      const recent = (failures.get(key) ?? []).filter((at) => now - at < windowMs);
      recent.push(now);
      failures.set(key, recent);
    },
  };
}

/**
 * The admin gate every /api/admin route sits behind: a valid admin-session
 * token or a 401 that says nothing about which part was wrong. The matched
 * token is put on the request for per-session state (the SQL console's write
 * mode is tracked per admin session).
 */
export function requireAdmin(tokens: Set<string>, cookieName: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = readCookie(req, cookieName);
    if (!token || !tokens.has(token)) {
      res.status(401).json({ error: "admin authentication required" });
      return;
    }
    (req as Request & { adminToken?: string }).adminToken = token;
    next();
  };
}
