import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import supertest from "supertest";
import type { Express } from "express";
import type Database from "better-sqlite3";
import { createApp } from "../app.js";
import type { Clock } from "../clock.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
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
} from "../domain.js";
import { getEmailPlug, createEmailPlugFromEnv, type LoggingEmailPlug } from "../domains/auth/email-plug.js";
import type { Role } from "../domains/auth/session.js";

/**
 * Injectable app clock for tests. Tests that exercise time-dependent rules
 * (login-link expiry, price expiry, audit due-ness) advance or set this clock
 * instead of sleeping — production code always reads time through the `Clock`
 * interface, never `new Date()` directly.
 */
export class FakeClock implements Clock {
  private current: Date;

  constructor(at: Date | string = "2026-09-24T12:00:00.000Z") {
    this.current = new Date(at);
  }

  now(): Date {
    return new Date(this.current);
  }

  set(at: Date | string): void {
    this.current = new Date(at);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

/** The default manager every test harness seeds directly. */
export const DEFAULT_MANAGER_EMAIL = "manager@acme.co";

// The email allowlist is env-configured (see server/domains/auth/users.ts and
// .env.example). Tests pin a neutral fictional domain for the whole worker —
// set, not ??=: a leftover value from the shell would silently win.
process.env.ALLOWED_EMAIL_DOMAINS = "@acme.co,@acme.com";

export interface TestHarnessUser {
  id: number;
  email: string;
  role: Role;
}

export interface LoggedInAgent {
  /** The logged-in user, exactly as /api/auth/redeem returned it. */
  user: TestHarnessUser;
  /** supertest agent carrying the session cookie — make requests as this user. */
  agent: ReturnType<typeof supertest.agent>;
}

/**
 * The sandbox instance of the harness: a second, fully wired app on its own
 * throwaway database, mounted at /sandbox on the main app exactly as
 * `server/index.ts` mounts it. Same shape as the prod surface, different
 * database and cookie names.
 */
export interface TestHarnessSandbox {
  /** Direct handle to the throwaway sandbox SQLite database. */
  readonly db: Database.Database;
  /** Where the sandbox database file lives. */
  readonly dbPath: string;
  /**
   * The sandbox app's email plug — same env-driven selection as prod's:
   * the logging plug's `.sent` outbox unless RESEND_KEY was pinned around
   * `createTestHarness` (then it is Resend and `.sent` does not exist).
   */
  readonly emails: LoggingEmailPlug;
}

export interface TestHarness {
  /** The Express app — wrap with supertest if you need a second handle. */
  readonly app: Express;
  /** Direct handle to the throwaway per-test SQLite database. */
  readonly db: Database.Database;
  /** Where the throwaway database file lives (backups land in a sibling `backups/`). */
  readonly dbPath: string;
  /** The fake clock injected into the app. */
  readonly clock: FakeClock;
  /** supertest agent bound to the app — use this to make requests. */
  readonly request: ReturnType<typeof supertest>;
  /**
   * The app's email plug — whatever `createEmailPlugFromEnv` picked: the
   * logging plug's `.sent` outbox unless RESEND_KEY was pinned around
   * `createTestHarness` (the Resend-selection tests do that deliberately,
   * and then `.sent` does not exist).
   */
  readonly emails: LoggingEmailPlug;
  /** The sandbox instance mounted at /sandbox (its own database and cookies). */
  readonly sandbox: TestHarnessSandbox;
  /**
   * Logs a user in through the real HTTP flow: request a link, retrieve it
   * from the email plug, redeem it. The returned agent carries the session
   * cookie, so later tickets can act as different users in one test.
   */
  loginAs(email: string): Promise<LoggedInAgent>;
  /**
   * The same login flow against the SANDBOX instance (/sandbox/api/...):
   * seeds, cookies, and sessions are the sandbox database's own.
   */
  loginAsOnSandbox(email: string): Promise<LoggedInAgent>;
  /**
   * Creates a user through the API (acting as the bootstrap manager), then
   * logs them in. The manager-role behavior this exercises is under test in
   * `users.test.ts`; later tickets just use it for setup.
   */
  createUserAs(email: string, role: Role): Promise<LoggedInAgent>;
  /** Closes the database and deletes the temp directory. Call in afterEach. */
  close(): void;
}

export interface TestHarnessOptions {
  /** Start the fake clock somewhere other than the default instant. */
  now?: Date | string;
  /**
   * ADMIN_KEY for this app (ticket 18 admin panel). Defaults to `null` —
   * the admin surface is disabled (404 everywhere), matching a production
   * run without the key. Pass a string to enable it; the same value then
   * opens an admin session via POST /api/admin/session.
   */
  adminKey?: string | null;
}

/**
 * The single test seam: an in-process HTTP app wired to a throwaway SQLite
 * file in a fresh temp directory, with migrations applied and a fake clock
 * injected — plus the sandbox instance mounted at /sandbox on that app,
 * exactly as the production entrypoint mounts it. No database mocking. Copy
 * this pattern in every test file:
 *
 *   let harness: TestHarness;
 *   beforeEach(() => { harness = createTestHarness(); });
 *   afterEach(() => { harness.close(); });
 */
export function createTestHarness(options: TestHarnessOptions = {}): TestHarness {
  const dir = mkdtempSync(path.join(tmpdir(), "repair-inventory-test-"));
  const db = openDatabase(path.join(dir, "test.sqlite"));
  const clock = new FakeClock(options.now);
  migrate(db, clock);

  // There is no bootstrap manager anymore (the admin panel owns user
  // creation now), so the harness SEEDS its default manager directly — no
  // HTTP, no provisioning. Tests need a signed-in manager for setup; how a
  // real shop gets its first manager is the admin panel's Users section.
  const managerEmail = DEFAULT_MANAGER_EMAIL;
  db.prepare("INSERT INTO users (email, role, active, created_at) VALUES (?, 'manager', 1, ?)").run(
    managerEmail,
    clock.now().toISOString(),
  );

  // ADMIN_KEY is read by the admin domain at registration: set around
  // createApp, restore immediately — no lingering process.env mutation.
  const adminKey = options.adminKey ?? null;
  const previousAdminKey = process.env.ADMIN_KEY;
  if (adminKey === null) {
    delete process.env.ADMIN_KEY;
  } else {
    process.env.ADMIN_KEY = adminKey;
  }
  const dbPath = path.join(dir, "test.sqlite");
  const app = createApp({
    db,
    clock,
    dbPath,
    sessionCookie: PROD_SESSION_COOKIE,
    adminCookie: PROD_ADMIN_COOKIE,
    mountPrefix: PROD_MOUNT_PREFIX,
    backupStem: PROD_BACKUP_STEM,
    stagedRestore: PROD_STAGED_RESTORE,
    // Each context selects its plug exactly as the production entrypoint
    // does: Resend when RESEND_KEY is set, console logging otherwise (the
    // Resend-selection tests pin that key around createTestHarness).
    emailPlug: createEmailPlugFromEnv("production"),
  });

  // The sandbox instance: a second database and app in the same harness,
  // mounted at /sandbox on the main app exactly as the production
  // entrypoint mounts it, with the sandbox's hard-derived cookie names. The
  // admin domain reads ADMIN_KEY at registration, so this stays inside the
  // env window above.
  const sandboxDbPath = path.join(dir, "sandbox.sqlite");
  const sandboxDb = openDatabase(sandboxDbPath);
  migrate(sandboxDb, clock);
  sandboxDb
    .prepare("INSERT INTO users (email, role, active, created_at) VALUES (?, 'manager', 1, ?)")
    .run(managerEmail, clock.now().toISOString());
  const sandboxApp = createApp({
    db: sandboxDb,
    clock,
    dbPath: sandboxDbPath,
    sessionCookie: SANDBOX_SESSION_COOKIE,
    adminCookie: SANDBOX_ADMIN_COOKIE,
    mountPrefix: SANDBOX_MOUNT_PREFIX,
    backupStem: SANDBOX_BACKUP_STEM,
    stagedRestore: SANDBOX_STAGED_RESTORE,
    // The sandbox selects its plug exactly as production does — same env,
    // same rule (spec decision 7, reversed 2026-10-06 by user request).
    // Outbox-reading tests require RESEND_KEY to be unset; the
    // Resend-selection tests pin it deliberately.
    emailPlug: createEmailPlugFromEnv("sandbox"),
  });
  app.use(SANDBOX_MOUNT_PREFIX, sandboxApp);

  if (previousAdminKey === undefined) {
    delete process.env.ADMIN_KEY;
  } else {
    process.env.ADMIN_KEY = previousAdminKey;
  }

  const emails = getEmailPlug(app);
  const sandboxEmails = getEmailPlug(sandboxApp);
  const request = supertest(app);

  async function loginOn(
    prefix: string,
    emails_: LoggingEmailPlug,
    email: string
  ): Promise<LoggedInAgent> {
    const requestLink = await request.post(`${prefix}/api/auth/request-link`).send({ email });
    if (requestLink.status !== 202) {
      throw new Error(
        `loginAs(${email}): POST ${prefix}/api/auth/request-link returned ${requestLink.status}`
      );
    }
    const link = [...emails_.sent].reverse().find((sent) => sent.to === email.toLowerCase());
    if (!link) {
      throw new Error(`loginAs(${email}): no login link was delivered for that address`);
    }
    const token = new URL(link.url).searchParams.get("token");
    if (!token) {
      throw new Error(`loginAs(${email}): delivered link has no token: ${link.url}`);
    }
    const agent = supertest.agent(app);
    const redeem = await agent.post(`${prefix}/api/auth/redeem`).send({ token });
    if (redeem.status !== 200) {
      throw new Error(`loginAs(${email}): POST ${prefix}/api/auth/redeem returned ${redeem.status}`);
    }
    return { user: redeem.body as TestHarnessUser, agent };
  }

  async function loginAs(email: string): Promise<LoggedInAgent> {
    return loginOn("", emails, email);
  }

  async function loginAsOnSandbox(email: string): Promise<LoggedInAgent> {
    return loginOn(SANDBOX_MOUNT_PREFIX, sandboxEmails, email);
  }

  async function createUserAs(email: string, role: Role): Promise<LoggedInAgent> {
    const manager = await loginAs(managerEmail);
    const created = await manager.agent.post("/api/users").send({ email, role });
    if (created.status !== 201) {
      throw new Error(`createUserAs(${email}): POST /api/users returned ${created.status}`);
    }
    return loginAs(email);
  }

  return {
    app,
    db,
    dbPath,
    clock,
    request,
    emails,
    sandbox: {
      db: sandboxDb,
      dbPath: sandboxDbPath,
      emails: sandboxEmails,
    },
    loginAs,
    loginAsOnSandbox,
    createUserAs,
    close() {
      db.close();
      sandboxDb.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
