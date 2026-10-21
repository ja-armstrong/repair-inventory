import { afterEach, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import {
  SANDBOX_ADMIN_COOKIE,
  SANDBOX_SESSION_COOKIE,
} from "../domain.js";
import { createTestHarness, type TestHarness } from "./harness.js";

// The sandbox instance (ticket: sandbox environment 01). Two fully wired
// instances run in one process: production at the root, the sandbox at
// /sandbox — each with its own SQLite database and its own cookie names.
// These tests pin the seam: writes never cross databases, both databases
// are migrated, both health routes answer, and the two instances never
// share a cookie name.
describe("sandbox instance", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("answers /health from the prod instance and /sandbox/health from the sandbox instance", async () => {
    const prod = await harness.request.get("/health");
    const sandbox = await harness.request.get("/sandbox/health");

    expect(prod.status).toBe(200);
    expect(sandbox.status).toBe(200);
    expect(prod.body).toEqual({ status: "ok", migrations: expect.any(Number) });
    expect(sandbox.body).toEqual({ status: "ok", migrations: expect.any(Number) });
    expect(sandbox.body.migrations).toBeGreaterThan(0);
  });

  it("migrates both databases at startup", () => {
    for (const db of [harness.db, harness.sandbox.db]) {
      const rows = db.prepare("SELECT name FROM migrations ORDER BY name").all() as Array<{
        name: string;
      }>;
      expect(rows.map((row) => row.name)).toContain("0001-migrations-table.sql");
    }
  });

  it("keeps writes in one instance invisible to the other", async () => {
    // The harness seeds a manager in EACH database; each acts only on its
    // own instance through the real HTTP surface.
    const prodManager = await harness.loginAs("manager@acme.co");
    const sandboxManager = await harness.loginAsOnSandbox("manager@acme.co");

    const prodCreate = await prodManager.agent
      .post("/api/users")
      .send({ email: "prod-only@acme.co", role: "tech" });
    expect(prodCreate.status).toBe(201);

    const sandboxCreate = await sandboxManager.agent
      .post("/sandbox/api/users")
      .send({ email: "sandbox-only@acme.co", role: "tech" });
    expect(sandboxCreate.status).toBe(201);

    const prodEmails = harness.db
      .prepare("SELECT email FROM users ORDER BY email")
      .all() as Array<{ email: string }>;
    const sandboxEmails = harness.sandbox.db
      .prepare("SELECT email FROM users ORDER BY email")
      .all() as Array<{ email: string }>;

    expect(prodEmails.map((row) => row.email)).toEqual([
      "manager@acme.co",
      "prod-only@acme.co",
    ]);
    expect(sandboxEmails.map((row) => row.email)).toEqual([
      "manager@acme.co",
      "sandbox-only@acme.co",
    ]);
  });

  it("sets different cookie names for the two instances", async () => {
    // Admin-session cookies: same ADMIN_KEY, different cookie names — the
    // two panels can never share a session.
    const keyed = createTestHarness({ adminKey: "test-admin-key" });
    try {
      const prodLogin = await keyed.request.post("/api/admin/session").send({ key: "test-admin-key" });
      const sandboxLogin = await keyed.request
        .post("/sandbox/api/admin/session")
        .send({ key: "test-admin-key" });

      expect(prodLogin.status).toBe(204);
      expect(sandboxLogin.status).toBe(204);
      expect(prodLogin.headers["set-cookie"]?.[0]).toContain("admin_session=");
      expect(sandboxLogin.headers["set-cookie"]?.[0]).toContain(`${SANDBOX_ADMIN_COOKIE}=`);

      // User-session cookies: a sandbox login sets sandbox_session, never
      // the prod "session" name.
      await keyed.request.post("/sandbox/api/auth/request-link").send({ email: "manager@acme.co" });
      const link = keyed.sandbox.emails.sent.at(-1);
      expect(link).toBeDefined();
      const token = new URL(link!.url).searchParams.get("token");
      expect(token).toBeTruthy();
      const redeem = await supertest.agent(keyed.app)
        .post("/sandbox/api/auth/redeem")
        .send({ token });
      expect(redeem.status).toBe(200);
      expect(redeem.headers["set-cookie"]?.[0]).toContain(`${SANDBOX_SESSION_COOKIE}=`);
    } finally {
      keyed.close();
    }
  });
});
