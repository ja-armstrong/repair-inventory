import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { SANDBOX_ADMIN_COOKIE, SANDBOX_SESSION_COOKIE } from "../domain.js";
import { createTestHarness, DEFAULT_MANAGER_EMAIL, type TestHarness } from "./harness.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;

/**
 * Sandbox auth (ticket: sandbox environment 03). The sandbox exercises the
 * REAL login flow with the context's seams: its login links carry the
 * /sandbox mount prefix, its email plug is picked by the SAME selection as
 * production (Resend when RESEND_KEY is set — decision 7, reversed
 * 2026-10-06 by user request), and its sessions live in sandbox_session /
 * sandbox_admin_session, so prod and sandbox logins coexist in one browser
 * without ever granting each other.
 */

/** Pins RESEND_KEY around the body, exactly as the auth tests pin theirs. */
async function withResendKey<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.RESEND_KEY;
  process.env.RESEND_KEY = "test-resend-key";
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.RESEND_KEY;
    } else {
      process.env.RESEND_KEY = previous;
    }
  }
}

/** Pins APP_ORIGIN around the body (the no-Origin-header link fallback). */
async function withAppOrigin<T>(body: () => Promise<T>): Promise<T> {
  const previous = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "https://rms.example";
  try {
    return await body();
  } finally {
    if (previous === undefined) {
      delete process.env.APP_ORIGIN;
    } else {
      process.env.APP_ORIGIN = previous;
    }
  }
}

/** Stubs global fetch, recording every call — the "did anything get sent" probe. */
function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch call");
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

describe("sandbox login links", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("carry the /sandbox mount prefix; prod links stay unprefixed (one shared builder)", async () => {
    await withAppOrigin(async () => {
      const prod = await harness.request.post("/api/auth/request-link").send({ email: MANAGER });
      expect(prod.status).toBe(202);
      // Anchored: /redeem comes directly after the origin — no prefix.
      expect(harness.emails.sent.at(-1)?.url).toMatch(/^https:\/\/rms\.example\/redeem\?token=/);

      const sandbox = await harness.request
        .post("/sandbox/api/auth/request-link")
        .send({ email: MANAGER });
      expect(sandbox.status).toBe(202);
      expect(harness.sandbox.emails.sent.at(-1)?.url).toMatch(
        /^https:\/\/rms\.example\/sandbox\/redeem\?token=/,
      );
    });
  });

  it("follow the request's Origin, prefixed — a LAN host stays clickable in the sandbox too", async () => {
    const response = await harness.request
      .post("/sandbox/api/auth/request-link")
      .set("Origin", "http://192.168.1.50:5173")
      .send({ email: MANAGER });
    expect(response.status).toBe(202);
    expect(harness.sandbox.emails.sent.at(-1)?.url).toMatch(
      /^http:\/\/192\.168\.1\.50:5173\/sandbox\/redeem\?token=/,
    );
  });

  it("email through the SAME selection as prod — with RESEND_KEY set, both instances send via Resend", async () => {
    await withResendKey(async () => {
      // Both contexts selected Resend because the key is set; the stub
      // answers exactly three sends: the prod request-link, the sandbox
      // request-link, and the sandbox admin panel's mint. A fourth send
      // would fail the request loudly AND the length assertion below.
      const calls = stubFetch([
        { status: 200, body: { id: "prod-email-id" } },
        { status: 200, body: { id: "sandbox-email-id" } },
        { status: 200, body: { id: "mint-email-id" } },
      ]);
      const resendHarness = createTestHarness({ adminKey: "test-admin-key" });
      try {
        const prod = await resendHarness.request.post("/api/auth/request-link").send({ email: MANAGER });
        expect(prod.status).toBe(202);
        const sandbox = await resendHarness.request
          .post("/sandbox/api/auth/request-link")
          .send({ email: MANAGER });
        expect(sandbox.status).toBe(202);

        // Same RESEND_KEY, same process: each instance sent exactly once.
        expect(calls).toHaveLength(2);
        expect(calls.every((call) => call.url === "https://api.resend.com/emails")).toBe(true);
        const prodBody = JSON.parse(String(calls[0].init.body)) as { to: string; text: string };
        expect(prodBody.to).toBe(MANAGER);
        const prodLink = prodBody.text.match(/https?:\/\/\S+/)?.[0];
        expect(prodLink).toMatch(/\/redeem\?token=/);
        expect(prodLink).not.toContain("/sandbox/");
        // The sandbox's email is real too; only the mount prefix marks it.
        const sandboxBody = JSON.parse(String(calls[1].init.body)) as { to: string; text: string };
        expect(sandboxBody.to).toBe(MANAGER);
        const linkUrl = sandboxBody.text.match(/https?:\/\/\S+/)?.[0];
        expect(linkUrl).toContain("/sandbox/redeem?token=");
        // The token really lives in the SANDBOX database.
        const token = new URL(linkUrl!).searchParams.get("token");
        const row = resendHarness.sandbox.db
          .prepare("SELECT user_id, used_at FROM login_tokens WHERE token = ?")
          .get(token) as { user_id: number; used_at: string | null } | undefined;
        expect(row).toBeDefined();
        expect(row!.used_at).toBeNull();

        // The mint route goes through the same sandbox plug: a real Resend
        // send whose link carries the /sandbox prefix.
        const admin = supertest.agent(resendHarness.app);
        const opened = await admin.post("/sandbox/api/admin/session").send({ key: "test-admin-key" });
        expect(opened.status).toBe(204);
        const minted = await admin
          .post("/sandbox/api/admin/users/1/login-link")
          .set("Origin", "http://trainhost.example")
          .send({});
        expect(minted.status).toBe(201);
        expect(calls).toHaveLength(3);
        const mintBody = JSON.parse(String(calls[2].init.body)) as { to: string; text: string };
        expect(mintBody.text).toMatch(/http:\/\/trainhost\.example\/sandbox\/redeem\?token=/);
      } finally {
        resendHarness.close();
      }
      vi.unstubAllGlobals();
    });
  });
});

describe("sandbox sessions", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("a prod session authorizes only prod, a sandbox session only the sandbox", async () => {
    const prodAgent = await harness.loginAs(MANAGER);
    expect((await prodAgent.agent.get("/api/auth/me")).status).toBe(200);
    expect((await prodAgent.agent.get("/sandbox/api/auth/me")).status).toBe(401);

    const sandboxAgent = await harness.loginAsOnSandbox(MANAGER);
    expect((await sandboxAgent.agent.get("/sandbox/api/auth/me")).status).toBe(200);
    expect((await sandboxAgent.agent.get("/api/auth/me")).status).toBe(401);
  });

  it("one browser holds both logins at once: prod stays logged in through a sandbox login, and vice versa", async () => {
    const browser = supertest.agent(harness.app);

    // Prod login through the real flow.
    await browser.post("/api/auth/request-link").send({ email: MANAGER });
    const prodToken = new URL(harness.emails.sent.at(-1)!.url).searchParams.get("token");
    const prodRedeem = await browser.post("/api/auth/redeem").send({ token: prodToken });
    expect(prodRedeem.status).toBe(200);
    expect(prodRedeem.headers["set-cookie"]?.[0]).toContain("session=");

    // The SAME cookie jar then logs into the sandbox.
    await browser.post("/sandbox/api/auth/request-link").send({ email: MANAGER });
    const sandboxToken = new URL(harness.sandbox.emails.sent.at(-1)!.url).searchParams.get("token");
    const sandboxRedeem = await browser.post("/sandbox/api/auth/redeem").send({ token: sandboxToken });
    expect(sandboxRedeem.status).toBe(200);
    expect(sandboxRedeem.headers["set-cookie"]?.[0]).toContain(`${SANDBOX_SESSION_COOKIE}=`);

    // Both sessions coexist: each surface reads only its own cookie name.
    expect((await browser.get("/api/auth/me")).status).toBe(200);
    expect((await browser.get("/sandbox/api/auth/me")).status).toBe(200);
  });
});

describe("the sandbox trainee path (admin panel → user → link → session)", () => {
  it("creates the user in the SANDBOX users table, mints a prefixed link, and redeems it into a sandbox session", async () => {
    const keyed = createTestHarness({ adminKey: "test-admin-key" });
    try {
      const admin = supertest.agent(keyed.app);
      const opened = await admin
        .post("/sandbox/api/admin/session")
        .send({ key: "test-admin-key" });
      expect(opened.status).toBe(204);
      expect(opened.headers["set-cookie"]?.[0]).toContain(`${SANDBOX_ADMIN_COOKIE}=`);

      const created = await admin
        .post("/sandbox/api/admin/users")
        .send({ email: "trainee@acme.co", role: "tech" });
      expect(created.status).toBe(201);
      const sandboxUser = keyed.sandbox.db
        .prepare("SELECT id, email, role FROM users WHERE email = ?")
        .get("trainee@acme.co") as { id: number; email: string; role: string };
      expect(sandboxUser).toMatchObject({ email: "trainee@acme.co", role: "tech" });
      // The users table diverges freely from prod — the trainee is invisible there.
      expect(
        keyed.db.prepare("SELECT id FROM users WHERE email = ?").get("trainee@acme.co"),
      ).toBeUndefined();

      const minted = await admin
        .post(`/sandbox/api/admin/users/${sandboxUser.id}/login-link`)
        .set("Origin", "http://trainhost.example")
        .send({});
      expect(minted.status).toBe(201);
      expect(minted.body.loginUrl).toMatch(/^http:\/\/trainhost\.example\/sandbox\/redeem\?token=/);
      // The console-logging plug captured the same link (it is also in the response).
      const delivered = keyed.sandbox.emails.sent.at(-1);
      expect(delivered?.to).toBe("trainee@acme.co");
      expect(delivered?.url).toBe(minted.body.loginUrl);

      // Opening the link redeems into a SANDBOX session (the client's
      // basename from ticket 02 lands /sandbox/redeem on the sandbox app).
      const trainee = supertest.agent(keyed.app);
      const token = new URL(minted.body.loginUrl as string).searchParams.get("token");
      const redeemed = await trainee.post("/sandbox/api/auth/redeem").send({ token });
      expect(redeemed.status).toBe(200);
      expect(redeemed.headers["set-cookie"]?.[0]).toContain(`${SANDBOX_SESSION_COOKIE}=`);
      const me = await trainee.get("/sandbox/api/auth/me");
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ email: "trainee@acme.co", role: "tech" });
    } finally {
      keyed.close();
    }
  });
});
