import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type TestHarness,
} from "./harness.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;

describe("GET /api/users", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("lists users for a manager", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    const response = await agent.get("/api/users");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      {
        id: expect.any(Number),
        email: MANAGER,
        role: "manager",
        active: true,
        createdAt: expect.any(String),
      },
    ]);
  });

  it("refuses a tech", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const response = await tech.agent.get("/api/users");

    expect(response.status).toBe(403);
    expect(response.body.error).toContain("manager");
  });
});

describe("POST /api/users", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("creates an allowlisted user and records a timeline event", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent
      .post("/api/users")
      .send({ email: "new.tech@acme.com", role: "tech" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(Number),
      email: "new.tech@acme.com",
      role: "tech",
      active: true,
      createdAt: expect.any(String),
    });

    const row = harness.db
      .prepare("SELECT email, role, active FROM users WHERE email = ?")
      .get("new.tech@acme.com") as { email: string; role: string; active: number };
    expect(row).toEqual({ email: "new.tech@acme.com", role: "tech", active: 1 });

    const event = harness.db
      .prepare("SELECT actor_id, at, action, payload FROM events WHERE entity_id = ?")
      .get(response.body.id) as { actor_id: number; at: string; action: string; payload: string };
    expect(event.actor_id).toBe(manager.user.id);
    expect(event.action).toBe("user.created");
    expect(event.at).toBe(harness.clock.now().toISOString());
    expect(JSON.parse(event.payload)).toEqual({ email: "new.tech@acme.com", role: "tech" });
  });

  it("rejects an email outside the allowlisted domains", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent
      .post("/api/users")
      .send({ email: "ringer@gmail.com", role: "tech" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("@acme.co");
    const count = harness.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("rejects a duplicate email", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent
      .post("/api/users")
      .send({ email: MANAGER, role: "tech" });

    expect(response.status).toBe(409);
  });

  it("creates an admin (a manager-equivalent) and still refuses a nonsense role", async () => {
    const manager = await harness.loginAs(MANAGER);
    const admin = await manager.agent
      .post("/api/users")
      .send({ email: "x@acme.co", role: "admin" });
    expect(admin.status).toBe(201);
    expect(admin.body.role).toBe("admin");

    const nonsense = await manager.agent
      .post("/api/users")
      .send({ email: "y@acme.co", role: "chief" });
    expect(nonsense.status).toBe(400);
  });

  it("refuses a tech", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const response = await tech.agent
      .post("/api/users")
      .send({ email: "other@acme.co", role: "tech" });

    expect(response.status).toBe(403);
    const count = harness.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    expect(count.n).toBe(2);
  });
});

describe("PATCH /api/users/:id/role", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("changes a tech to a manager and records old-to-new values on the timeline", async () => {
    const manager = await harness.loginAs(MANAGER);
    const created = await manager.agent
      .post("/api/users")
      .send({ email: "promoted@acme.co", role: "tech" });
    expect(created.status).toBe(201);

    const response = await manager.agent
      .patch(`/api/users/${created.body.id}/role`)
      .send({ role: "manager" });

    expect(response.status).toBe(200);
    expect(response.body.role).toBe("manager");

    const row = harness.db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(created.body.id) as { role: string };
    expect(row.role).toBe("manager");

    const event = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE entity_id = ? AND action = ?")
      .get(created.body.id, "user.role_changed") as {
      actor_id: number;
      action: string;
      payload: string;
    };
    expect(event.actor_id).toBe(manager.user.id);
    expect(JSON.parse(event.payload)).toEqual({ from: "tech", to: "manager" });
  });

  it("refuses a tech", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const response = await tech.agent
      .patch(`/api/users/${tech.user.id}/role`)
      .send({ role: "manager" });

    expect(response.status).toBe(403);
  });

  it("rejects an unknown user id", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent
      .patch("/api/users/9999/role")
      .send({ role: "tech" });

    expect(response.status).toBe(404);
  });

  it("rejects an invalid role value", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent
      .patch(`/api/users/${tech.user.id}/role`)
      .send({ role: "chief" });

    expect(response.status).toBe(400);
  });

  it("refuses to demote the last active manager", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent
      .patch(`/api/users/${manager.user.id}/role`)
      .send({ role: "tech" });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("last active manager");
    const row = harness.db
      .prepare("SELECT role FROM users WHERE id = ?")
      .get(manager.user.id) as { role: string };
    expect(row.role).toBe("manager");
  });

  it("lets a manager demote themselves when another manager exists", async () => {
    const manager = await harness.loginAs(MANAGER);
    const created = await manager.agent
      .post("/api/users")
      .send({ email: "second@acme.co", role: "manager" });
    expect(created.status).toBe(201);

    const response = await manager.agent
      .patch(`/api/users/${manager.user.id}/role`)
      .send({ role: "tech" });

    expect(response.status).toBe(200);
    expect(response.body.role).toBe("tech");
  });
});

describe("POST /api/users/:id/deactivate", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("deactivates a user, kills their session, blocks re-login, and records an event", async () => {
    const manager = await harness.loginAs(MANAGER);
    const tech = await harness.createUserAs("tech@acme.co", "tech");

    // an outstanding login link for the tech, requested before deactivation
    const outstanding = await harness.request
      .post("/api/auth/request-link")
      .send({ email: "tech@acme.co" });
    expect(outstanding.status).toBe(202);

    const response = await manager.agent.post(`/api/users/${tech.user.id}/deactivate`);

    expect(response.status).toBe(200);
    expect(response.body.active).toBe(false);

    // their existing session is gone
    const me = await tech.agent.get("/api/auth/me");
    expect(me.status).toBe(401);

    // they cannot request a new link
    const refused = await harness.request
      .post("/api/auth/request-link")
      .send({ email: "tech@acme.co" });
    expect(refused.status).toBe(403);

    // their outstanding link cannot be redeemed
    const link = harness.emails.sent.at(-1);
    const token = link ? new URL(link.url).searchParams.get("token") : null;
    const redeem = await harness.request.post("/api/auth/redeem").send({ token });
    expect(redeem.status).toBe(403);

    const event = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE entity_id = ? AND action = ?")
      .get(tech.user.id, "user.deactivated") as { actor_id: number; action: string; payload: string };
    expect(event.actor_id).toBe(manager.user.id);
    expect(JSON.parse(event.payload)).toEqual({ email: "tech@acme.co" });
  });

  it("refuses a tech", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const response = await tech.agent.post(`/api/users/${tech.user.id}/deactivate`);

    expect(response.status).toBe(403);
  });

  it("rejects an unknown user id", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent.post("/api/users/9999/deactivate");

    expect(response.status).toBe(404);
  });

  it("refuses to deactivate the last active manager", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent.post(`/api/users/${manager.user.id}/deactivate`);

    expect(response.status).toBe(409);
    const row = harness.db
      .prepare("SELECT active FROM users WHERE id = ?")
      .get(manager.user.id) as { active: number };
    expect(row.active).toBe(1);
  });
});
