import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import type { TestHarness } from "./harness.js";
import { createTestHarness, DEFAULT_MANAGER_EMAIL } from "./harness.js";
import { openDatabase } from "../db/connection.js";
import { knownMigrationNames } from "../db/migrate.js";
import { validateBackupFile } from "../domains/admin/backups.js";
import { CLEAR_CONFIRMATION_PHRASE } from "../domains/admin/index.js";

/**
 * Sandbox ticket 04 — the admin panel's sandbox semantics. The same admin
 * domain registers in BOTH instances; these tests pin the parts whose
 * behavior must name and hit the SANDBOX database: backup naming
 * (`sandbox-…` in the shared data/backups folder), clear wiping only the
 * sandbox, sandbox-scoped system info and environment, the API console
 * dispatching into the sandbox app (not production), and admin-key sessions
 * that live and die independently of a prod admin session in the same
 * browser (different cookie names — the ticket-01 seam).
 */

const ADMIN_KEY = "test-admin-key";
const MANAGER = DEFAULT_MANAGER_EMAIL;

// The number of migrations on disk — asserted as "every migration applied"
// rather than a literal, so adding a migration file never re-breaks these.
const MIGRATION_COUNT = knownMigrationNames().length;

interface HarnessHandle {
  harness: TestHarness;
  /** supertest agent carrying the PROD admin cookie. */
  admin: ReturnType<typeof supertest.agent>;
  /** supertest agent carrying the SANDBOX admin cookie. */
  sandboxAdmin: ReturnType<typeof supertest.agent>;
}

function backupsDirOf(harness: TestHarness): string {
  // Both instances' databases live in the same directory, so BOTH panels'
  // backups land in this one folder (spec: same data/backups/).
  return path.join(path.dirname(harness.dbPath), "backups");
}

function listBackups(harness: TestHarness): string[] {
  const dir = backupsDirOf(harness);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** Pins environment variables around one awaited request, restoring after. */
async function withPinnedEnv<T>(
  pins: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(pins)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withBothAdmins(): Promise<HarnessHandle> {
  const harness = createTestHarness({ adminKey: ADMIN_KEY });
  const admin = supertest.agent(harness.app);
  const prodLogin = await admin.post("/api/admin/session").send({ key: ADMIN_KEY });
  expect(prodLogin.status).toBe(204);
  const sandboxAdmin = supertest.agent(harness.app);
  const sandboxLogin = await sandboxAdmin.post("/sandbox/api/admin/session").send({ key: ADMIN_KEY });
  expect(sandboxLogin.status).toBe(204);
  return { harness, admin, sandboxAdmin };
}

describe("sandbox admin panel", () => {
  let ctx: HarnessHandle;
  let sandboxManager: ReturnType<typeof supertest.agent>;
  let prodManager: ReturnType<typeof supertest.agent>;

  beforeAll(async () => {
    ctx = await withBothAdmins();
    const sandboxLogin = await ctx.harness.loginAsOnSandbox(MANAGER);
    sandboxManager = sandboxLogin.agent;
    const prodLogin = await ctx.harness.loginAs(MANAGER);
    prodManager = prodLogin.agent;
  });

  afterAll(() => ctx.harness.close());

  it("backup saves the SANDBOX database as sandbox-*.sqlite and its contents are the sandbox's", async () => {
    // One row that exists ONLY in the sandbox, one ONLY in production.
    const sandboxSku = await sandboxManager
      .post("/sandbox/api/skus")
      .send({ name: "Sandbox Only Screen", price: "1.00", kind: "serialized" });
    expect(sandboxSku.status).toBe(201);
    const prodSku = await prodManager
      .post("/api/skus")
      .send({ name: "Prod Only Screen", price: "2.00", kind: "serialized" });
    expect(prodSku.status).toBe(201);

    const response = await ctx.sandboxAdmin.get("/sandbox/api/admin/backup");
    expect(response.status).toBe(200);
    const disposition = response.headers["content-disposition"] as string;
    expect(disposition).toMatch(/attachment; filename="sandbox-\d{8}-\d{6}\.sqlite"/);

    const saved = listBackups(ctx.harness).filter((name) => name.startsWith("sandbox-"));
    expect(saved).toHaveLength(1);
    expect(validateBackupFile(path.join(backupsDirOf(ctx.harness), saved[0]))).toEqual({ ok: true });

    // The snapshot holds the sandbox's row and NOT the prod-only row.
    const snapshot = openDatabase(path.join(backupsDirOf(ctx.harness), saved[0]));
    try {
      const sandboxRow = snapshot
        .prepare("SELECT name FROM skus WHERE name = 'Sandbox Only Screen'")
        .get();
      expect(sandboxRow).toBeTruthy();
      const prodRow = snapshot
        .prepare("SELECT name FROM skus WHERE name = 'Prod Only Screen'")
        .get();
      expect(prodRow).toBeUndefined();
    } finally {
      snapshot.close();
    }

    // The production panel keeps its existing filename — and its snapshot is
    // the PROD database: the prod-only row in, the sandbox-only row out.
    const prodResponse = await ctx.admin.get("/api/admin/backup");
    expect(prodResponse.status).toBe(200);
    expect(prodResponse.headers["content-disposition"] as string).toMatch(
      /attachment; filename="repair-inventory-\d{8}-\d{6}\.sqlite"/
    );
    const prodBackupName = listBackups(ctx.harness).find((name) =>
      name.startsWith("repair-inventory-")
    );
    expect(prodBackupName).toBeDefined();
    const prodSnapshot = openDatabase(path.join(backupsDirOf(ctx.harness), prodBackupName!));
    try {
      expect(
        prodSnapshot.prepare("SELECT name FROM skus WHERE name = 'Prod Only Screen'").get()
      ).toBeTruthy();
      expect(
        prodSnapshot.prepare("SELECT name FROM skus WHERE name = 'Sandbox Only Screen'").get()
      ).toBeUndefined();
    } finally {
      prodSnapshot.close();
    }
  });

  it("clear empties only the sandbox database; prod row counts are unchanged", async () => {
    await sandboxManager
      .post("/sandbox/api/skus")
      .send({ name: "Doomed Sandbox Screen", price: "3.00", kind: "serialized" });
    await prodManager
      .post("/api/skus")
      .send({ name: "Surviving Prod Screen", price: "4.00", kind: "serialized" });

    const prodSkusBefore = (
      ctx.harness.db.prepare("SELECT COUNT(*) AS n FROM skus").get() as { n: number }
    ).n;
    const prodUsersBefore = (
      ctx.harness.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }
    ).n;

    // The same typed phrase as production — the danger rule does not loosen
    // because the target is the sandbox. The clock moves first so this
    // test's pre-clear backup lands on its own timestamp (the backup test
    // used the same pinned second; a same-second collision would still be
    // safe — suffixed, never overwritten — but the plain name reads better).
    ctx.harness.clock.advance(1000);
    const wrong = await ctx.sandboxAdmin
      .post("/sandbox/api/admin/clear")
      .send({ confirmation: "erase all data" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain(CLEAR_CONFIRMATION_PHRASE);

    const response = await ctx.sandboxAdmin
      .post("/sandbox/api/admin/clear")
      .send({ confirmation: CLEAR_CONFIRMATION_PHRASE });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    // The pre-clear safety backup gets the sandbox- prefix too.
    expect(response.body.backup).toMatch(/^sandbox-\d{8}-\d{6}\.sqlite$/);
    expect(listBackups(ctx.harness)).toContain(response.body.backup);
    const preClear = openDatabase(path.join(backupsDirOf(ctx.harness), response.body.backup));
    try {
      expect(
        preClear.prepare("SELECT name FROM skus WHERE name = 'Doomed Sandbox Screen'").get()
      ).toBeTruthy();
    } finally {
      preClear.close();
    }

    // The sandbox is fresh: every table dropped and rebuilt by the runner.
    const sandboxApplied = ctx.harness.sandbox.db
      .prepare("SELECT COUNT(*) AS n FROM migrations")
      .get() as { n: number };
    expect(sandboxApplied.n).toBe(MIGRATION_COUNT);
    expect(
      (ctx.harness.sandbox.db.prepare("SELECT COUNT(*) AS n FROM skus").get() as { n: number }).n
    ).toBe(0);
    expect(
      (ctx.harness.sandbox.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n
    ).toBe(0);

    // Production is untouched: same rows, same users.
    expect(
      (ctx.harness.db.prepare("SELECT COUNT(*) AS n FROM skus").get() as { n: number }).n
    ).toBe(prodSkusBefore);
    expect(
      (ctx.harness.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n
    ).toBe(prodUsersBefore);
    expect(
      ctx.harness.db.prepare("SELECT name FROM skus WHERE name = 'Surviving Prod Screen'").get()
    ).toBeTruthy();
  });

  it("system info reports the SANDBOX database path and size", async () => {
    const sandboxSystem = await ctx.sandboxAdmin.get("/sandbox/api/admin/system");
    expect(sandboxSystem.status).toBe(200);
    expect(sandboxSystem.body.dbPath).toBe(ctx.harness.sandbox.dbPath);
    expect(sandboxSystem.body.dbSizeBytes).toBe(fs.statSync(ctx.harness.sandbox.dbPath).size);
    expect(sandboxSystem.body.backupsDirectory).toBe(backupsDirOf(ctx.harness));

    // The prod panel reports the PROD file — the pages never blur together.
    const prodSystem = await ctx.admin.get("/api/admin/system");
    expect(prodSystem.body.dbPath).toBe(ctx.harness.dbPath);
    expect(prodSystem.body.dbPath).not.toBe(sandboxSystem.body.dbPath);
  });

  it("environment page shows the shared .env keys plus the sandbox's resolved db path and mount", async () => {
    const sandboxEnv = await ctx.sandboxAdmin.get("/sandbox/api/admin/env");
    expect(sandboxEnv.status).toBe(200);
    const keys = (sandboxEnv.body.entries as Array<{ key: string }>).map((entry) => entry.key);
    // The SAME shared catalog both panels edit.
    expect(keys).toContain("APP_ORIGIN");
    expect(keys).toContain("ADMIN_KEY");
    expect(keys).toContain("DB_PATH");
    expect(sandboxEnv.body.instance).toEqual({
      dbPath: ctx.harness.sandbox.dbPath,
      mountPrefix: "/sandbox",
    });

    const prodEnv = await ctx.admin.get("/api/admin/env");
    expect(prodEnv.body.instance).toEqual({
      dbPath: ctx.harness.dbPath,
      mountPrefix: "",
    });
  });

  it("API console dispatches into the SANDBOX app as the sandbox manager", async () => {
    // Distinct users seeded straight into each database: the console's user
    // list must be the SANDBOX one. The console runs as the FIRST active
    // manager/admin, and the clear test above wiped the sandbox's seeded
    // manager — this insert is both the console's actor and the probe row.
    ctx.harness.sandbox.db
      .prepare("INSERT INTO users (email, role, active, created_at) VALUES (?, 'manager', 1, ?)")
      .run("sandbox-console@acme.co", ctx.harness.clock.now().toISOString());
    ctx.harness.db
      .prepare("INSERT INTO users (email, role, active, created_at) VALUES (?, 'tech', 1, ?)")
      .run("prod-console@acme.co", ctx.harness.clock.now().toISOString());

    // The console self-fetches over real HTTP; give the harness app a real
    // listener and pin PORT the way server/index.ts reads it.
    const server = http.createServer(ctx.harness.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await withPinnedEnv({ PORT: String(port) }, () =>
        ctx.sandboxAdmin
          .post("/sandbox/api/admin/api-console")
          .send({ method: "GET", path: "/api/users" })
      );
      expect(response.status).toBe(200);
      expect(response.body.status).toBe(200);
      // GET /api/users answers with a bare array — shown verbatim.
      const emails = (response.body.body as Array<{ email: string }>).map((user) => user.email);
      expect(emails).toContain("sandbox-console@acme.co");
      expect(emails).not.toContain("prod-console@acme.co");

      // One console call = one ephemeral session, in the SANDBOX database.
      const sessions = ctx.harness.sandbox.db
        .prepare("SELECT COUNT(*) AS n FROM sessions")
        .get() as { n: number };
      expect(sessions.n).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe("sandbox admin session independence", () => {
  it("sandbox key login and lock work independently of a prod admin session in the same browser", async () => {
    const keyed = createTestHarness({ adminKey: ADMIN_KEY });
    try {
      // ONE cookie jar — the same-browser situation.
      const jar = supertest.agent(keyed.app);

      // With only a prod admin session, the sandbox panel grants nothing:
      // different cookie name, different in-memory token store.
      const prodLogin = await jar.post("/api/admin/session").send({ key: ADMIN_KEY });
      expect(prodLogin.status).toBe(204);
      expect(prodLogin.headers["set-cookie"]?.[0]).toContain("admin_session=");
      const sandboxBefore = await jar.get("/sandbox/api/admin/session");
      expect(sandboxBefore.status).toBe(401);

      // The same key opens the sandbox panel under its OWN cookie.
      const sandboxLogin = await jar.post("/sandbox/api/admin/session").send({ key: ADMIN_KEY });
      expect(sandboxLogin.status).toBe(204);
      expect(sandboxLogin.headers["set-cookie"]?.[0]).toContain("sandbox_admin_session=");
      expect(await jar.get("/api/admin/session")).toMatchObject({ status: 200 });
      expect(await jar.get("/sandbox/api/admin/session")).toMatchObject({ status: 200 });

      // Locking the sandbox panel leaves the prod session open.
      const lock = await jar.delete("/sandbox/api/admin/session");
      expect(lock.status).toBe(204);
      expect((await jar.get("/sandbox/api/admin/session")).status).toBe(401);
      expect((await jar.get("/api/admin/session")).status).toBe(200);

      // A wrong-key attempt on the sandbox disturbs nothing in prod.
      const wrongKey = await jar.post("/sandbox/api/admin/session").send({ key: "wrong" });
      expect(wrongKey.status).toBe(401);
      expect((await jar.get("/api/admin/session")).status).toBe(200);

      // Back in, and now locking PROD leaves the sandbox open — the reverse
      // direction of the same independence.
      expect(
        (await jar.post("/sandbox/api/admin/session").send({ key: ADMIN_KEY })).status
      ).toBe(204);
      expect((await jar.delete("/api/admin/session")).status).toBe(204);
      expect((await jar.get("/api/admin/session")).status).toBe(401);
      expect((await jar.get("/sandbox/api/admin/session")).status).toBe(200);
    } finally {
      keyed.close();
    }
  });
});
