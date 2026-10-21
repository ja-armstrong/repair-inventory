import { Router } from "express";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { AppContext, Domain } from "../../domain.js";
import {
  clearSessionCookie,
  createSession,
  createSessionMiddleware,
  deleteSession,
  randomToken,
  readSessionCookie,
  requireSession,
  setSessionCookie,
  type Role,
} from "./session.js";
import { allowedEmailDomainsMessage, isAllowlistedEmail, registerUsersRoutes } from "./users.js";

/** Magic links expire after 15 minutes — a leaked link is useless quickly. */
export const LOGIN_LINK_TTL_MS = 15 * 60 * 1000;

const requestLinkSchema = z.object({ email: z.email() });
const redeemSchema = z.object({ token: z.string().min(1) });

/**
 * The auth domain: passwordless login (magic links via the email plug),
 * persistent sessions, user management, and — as its registration side
 * effect — the shared, session-gated `/api` router every later domain
 * attaches its routes to.
 *
 * The pattern every later domain copies (register after `auth` in
 * `server/bootstrap.ts`):
 *
 *   import { getApiRouter, requireManager } from "../auth/index.js";
 *
 *   register(app, ctx) {
 *     const api = getApiRouter(app);            // session-gated; auth first
 *     api.get("/things", (req, res) => {        // req.currentUser is set
 *       const actor = req.currentUser!;
 *       ...
 *     });
 *     api.post("/things/:id/approve", requireManager, approveHandler);
 *   }
 *
 * Timeline writes go through `recordEvent` from `./events.js` — the single
 * write path for notes-and-events timelines across all domains.
 */
export const authDomain: Domain = {
  name: "auth",
  register(app: Express, ctx: AppContext) {
    // The email plug comes from the context — the composition root picked
    // the implementation for THIS instance (both instances run the same
    // selection: Resend when RESEND_KEY is set, console logging otherwise).
    // Installed here for the test/dev retrieval seam (getEmailPlug) and the
    // admin domain.
    app.locals.emailPlug = ctx.emailPlug;

    const api = Router();

    // Resolve the acting user for every /api request (never rejects)...
    api.use(createSessionMiddleware(ctx));

    // ...then the login flow itself — the chicken-and-egg exception that,
    // with /health, completes the set of unauthenticated endpoints.
    api.post("/auth/request-link", async (req, res) => {
      await handleRequestLink(req, res, ctx);
    });
    api.post("/auth/redeem", async (req, res) => {
      await handleRedeem(req, res, ctx);
    });

    // Everything below — and every route a later domain adds to this router —
    // requires a session.
    api.use(requireSession);

    api.get("/auth/me", (req, res) => {
      res.json(req.currentUser);
    });

    api.post("/auth/logout", (req, res) => {
      const token = readSessionCookie(req, ctx.sessionCookie);
      if (token) {
        deleteSession(ctx.db, token);
      }
      clearSessionCookie(res, ctx.sessionCookie);
      res.status(204).end();
    });

    registerUsersRoutes(api, ctx);

    app.use("/api", api);
    app.locals.api = api;
  },
};

/**
 * Login links must open the same host the requester used. APP_ORIGIN is the
 * fallback when the browser did not send Origin (tests, curl). Preferring
 * Origin means a LAN demo at http://192.168.1.x (or http://rmshost.local)
 * still gets a clickable link instead of localhost.
 */
export function loginLinkOrigin(req: Request): string {
  const header = req.get("origin");
  if (header) {
    try {
      const parsed = new URL(header);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.origin;
      }
    } catch {
      // malformed Origin — use the configured fallback
    }
  }
  return process.env.APP_ORIGIN ?? "http://localhost:3000";
}

/**
 * The ONE builder for login-link URLs — both build sites (the public
 * request-link flow and the admin panel's mint route) go through it, so the
 * rule exists exactly once: a link must open the instance that minted it,
 * so the context's mount prefix is part of the path (the sandbox's links are
 * `${origin}/sandbox/redeem?token=...`, prod's stay unprefixed) and the
 * origin rule is request Origin wins, APP_ORIGIN the fallback. An explicit
 * `originOverride` (the admin mint route's body field) wins when non-empty.
 */
export function buildLoginLinkUrl(
  req: Request,
  ctx: AppContext,
  token: string,
  originOverride?: string
): string {
  const origin =
    originOverride !== undefined && originOverride !== "" ? originOverride : loginLinkOrigin(req);
  return `${origin}${ctx.mountPrefix}/redeem?token=${token}`;
}

/** The session-gated /api router the auth domain mounted. Later domains register routes on it. */
export function getApiRouter(app: Express): Router {
  const router = (app.locals as { api?: Router }).api;
  if (!router) {
    throw new Error("the auth domain must be registered before any other /api domain");
  }
  return router;
}

async function handleRequestLink(req: Request, res: Response, ctx: AppContext): Promise<void> {
  const parsed = requestLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "a valid email address is required" });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  if (!isAllowlistedEmail(email)) {
    res.status(400).json({ error: allowedEmailDomainsMessage() });
    return;
  }
  const user = ctx.db
    .prepare("SELECT id, active FROM users WHERE email = ?")
    .get(email) as { id: number; active: number } | undefined;
  if (!user) {
    res.status(404).json({ error: "no user with that email" });
    return;
  }
  if (user.active === 0) {
    res.status(403).json({ error: "that user is deactivated" });
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

  const loginUrl = buildLoginLinkUrl(req, ctx, token);
  await ctx.emailPlug.sendLoginLink(email, loginUrl, expiresAt);
  // The logging plug is the delivery path until SMTP exists: the link goes to
  // the server console, not the API response — a response copy would let
  // anyone on the network mint a login link for any registered email.
  res.status(202).json({ ok: true });
}

async function handleRedeem(req: Request, res: Response, ctx: AppContext): Promise<void> {
  const parsed = redeemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "a login token is required" });
    return;
  }
  const row = ctx.db
    .prepare(
      `SELECT t.token, t.used_at, t.expires_at, u.id, u.email, u.role, u.active
         FROM login_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token = ?`
    )
    .get(parsed.data.token) as {
    token: string;
    used_at: string | null;
    expires_at: string;
    id: number;
    email: string;
    role: Role;
    active: number;
  } | undefined;
  if (!row) {
    res.status(400).json({ error: "unknown login link" });
    return;
  }
  if (row.used_at !== null) {
    // The token's own session re-presenting it is a double-submit (React
    // StrictMode remount, double-click, network retry): answer with the
    // session, not a dead-end error. Any other caller is still rejected —
    // the link stays single-use.
    const cookieToken = readSessionCookie(req, ctx.sessionCookie);
    const session = cookieToken
      ? (ctx.db
          .prepare("SELECT user_id, created_by_token FROM sessions WHERE token = ?")
          .get(cookieToken) as
        | { user_id: number; created_by_token: string | null }
        | undefined)
      : undefined;
    if (session && session.created_by_token === row.token && session.user_id === row.id) {
      if (row.active === 0) {
        res.status(403).json({ error: "that user is deactivated" });
        return;
      }
      res.json({ id: row.id, email: row.email, role: row.role });
      return;
    }
    res.status(400).json({ error: "login link already used" });
    return;
  }
  const now = ctx.clock.now();
  if (now.getTime() >= Date.parse(row.expires_at)) {
    res.status(400).json({ error: "login link expired" });
    return;
  }
  if (row.active === 0) {
    res.status(403).json({ error: "that user is deactivated" });
    return;
  }

  // Consume the token and create the session atomically: single-use means
  // single-use even under concurrent redemptions.
  const redeem = ctx.db.transaction((): string => {
    const consumed = ctx.db
      .prepare("UPDATE login_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL")
      .run(now.toISOString(), row.token);
    if (consumed.changes === 0) {
      throw new ReusedTokenError();
    }
    return createSession(ctx.db, now, row.id, row.token);
  });
  let sessionToken: string;
  try {
    sessionToken = redeem();
  } catch (error) {
    if (error instanceof ReusedTokenError) {
      res.status(400).json({ error: "login link already used" });
      return;
    }
    throw error;
  }

  setSessionCookie(res, ctx.sessionCookie, sessionToken);
  res.json({ id: row.id, email: row.email, role: row.role });
}

class ReusedTokenError extends Error {
  constructor() {
    super("login link already used");
  }
}
