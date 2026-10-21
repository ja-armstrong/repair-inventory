import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type TestHarness,
} from "./harness.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;
const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** Requests a login link over HTTP and returns the delivered token. */
async function requestLinkToken(harness: TestHarness, email: string): Promise<string> {
  const response = await harness.request.post("/api/auth/request-link").send({ email });
  expect(response.status).toBe(202);
  const link = harness.emails.sent.at(-1);
  const token = link ? new URL(link.url).searchParams.get("token") : null;
  if (!token) throw new Error("no token in the delivered link");
  return token;
}

/** First (and only) cookie pair, e.g. "session=abc", from a Set-Cookie header. */
function sessionCookiePair(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers["set-cookie"] as string | string[] | undefined;
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!first) throw new Error("no Set-Cookie header on the response");
  return first.split(";")[0];
}

describe("POST /api/auth/request-link", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("issues a single-use token that expires after 15 minutes, and delivers the link through the email plug", async () => {
    const response = await harness.request.post("/api/auth/request-link").send({
      email: MANAGER,
    });

    expect(response.status).toBe(202);

    const token = harness.db
      .prepare("SELECT token, used_at, expires_at FROM login_tokens")
      .get() as { token: string; used_at: string | null; expires_at: string };
    expect(token.used_at).toBeNull();
    expect(Date.parse(token.expires_at)).toBe(harness.clock.now().getTime() + FIFTEEN_MINUTES);

    const link = harness.emails.sent.at(-1);
    expect(link?.to).toBe(MANAGER);
    expect(link?.url).toContain(`/redeem?token=${token.token}`);
    expect(link?.url).toMatch(/^https?:\/\//);
  });

  it("builds the login link from the request Origin so a LAN host is usable", async () => {
    await harness.request
      .post("/api/auth/request-link")
      .set("Origin", "http://192.168.1.100:5173")
      .send({ email: MANAGER });

    expect(harness.emails.sent.at(-1)?.url).toMatch(/^http:\/\/192\.168\.1\.100:5173\/redeem\?token=/);
  });

  it("rejects an email outside the allowlisted domains", async () => {
    const response = await harness.request.post("/api/auth/request-link").send({
      email: "someone@gmail.com",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("@acme.co");
    const tokens = harness.db.prepare("SELECT COUNT(*) AS n FROM login_tokens").get() as {
      n: number;
    };
    expect(tokens.n).toBe(0);
    expect(harness.emails.sent).toHaveLength(0);
  });

  it("rejects a malformed email address", async () => {
    const response = await harness.request.post("/api/auth/request-link").send({
      email: "not-an-email",
    });

    expect(response.status).toBe(400);
  });

  it("rejects an allowlisted email with no user", async () => {
    const response = await harness.request.post("/api/auth/request-link").send({
      email: "stranger@acme.com",
    });

    expect(response.status).toBe(404);
    const tokens = harness.db.prepare("SELECT COUNT(*) AS n FROM login_tokens").get() as {
      n: number;
    };
    expect(tokens.n).toBe(0);
    expect(harness.emails.sent).toHaveLength(0);
  });
});

describe("POST /api/auth/redeem", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("returns success, not an error, when the token's own session re-redeems it (double-submit armor)", async () => {
    const token = await requestLinkToken(harness, MANAGER);
    const first = await harness.request.post("/api/auth/redeem").send({ token });
    expect(first.status).toBe(200);
    const cookie = sessionCookiePair(first);

    // The same browser re-presenting the link (React StrictMode remount,
    // double-click, retry) must land logged-in, not on an error page.
    const second = await harness.request
      .post("/api/auth/redeem")
      .set("Cookie", cookie)
      .send({ token });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it("still rejects an already-used token presented by a different session", async () => {
    const token = await requestLinkToken(harness, MANAGER);
    const first = await harness.request.post("/api/auth/redeem").send({ token });
    expect(first.status).toBe(200);

    const other = await harness.request.post("/api/auth/redeem").send({ token });
    expect(other.status).toBe(400);
    expect(other.body).toEqual({ error: "login link already used" });
  });

  it("establishes a persistent session with an httpOnly cookie and consumes the token", async () => {
    const token = await requestLinkToken(harness, MANAGER);
    const response = await harness.request.post("/api/auth/redeem").send({ token });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: expect.any(Number),
      email: MANAGER,
      role: "manager",
    });

    const setCookie = response.headers["set-cookie"] as string | string[] | undefined;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) as string;
    expect(cookie).toContain("session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");

    // the token is single-use: used_at is stamped through the injectable clock
    const tokenRow = harness.db
      .prepare("SELECT used_at FROM login_tokens WHERE token = ?")
      .get(token) as { used_at: string };
    expect(tokenRow.used_at).toBe(harness.clock.now().toISOString());

    // the session persists server-side
    const session = harness.db
      .prepare("SELECT user_id FROM sessions WHERE token = ?")
      .get(sessionCookiePair(response).split("=")[1]) as { user_id: number };
    expect(session.user_id).toBe(response.body.id);

    // the cookie authenticates a later request
    const me = await harness.request.get("/api/auth/me").set("Cookie", sessionCookiePair(response));
    expect(me.status).toBe(200);
    expect(me.body).toEqual(response.body);
  });

  it("still redeems one millisecond before expiry", async () => {
    const token = await requestLinkToken(harness, MANAGER);
    harness.clock.advance(FIFTEEN_MINUTES - 1);
    const response = await harness.request.post("/api/auth/redeem").send({ token });
    expect(response.status).toBe(200);
  });

  it("rejects a link redeemed after 15 minutes", async () => {
    const token = await requestLinkToken(harness, MANAGER);
    harness.clock.advance(FIFTEEN_MINUTES);
    const response = await harness.request.post("/api/auth/redeem").send({ token });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("expired");
    const sessions = harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {
      n: number;
    };
    expect(sessions.n).toBe(0);
  });

  it("rejects a reused link", async () => {
    const token = await requestLinkToken(harness, MANAGER);
    const first = await harness.request.post("/api/auth/redeem").send({ token });
    expect(first.status).toBe(200);

    const second = await harness.request.post("/api/auth/redeem").send({ token });
    expect(second.status).toBe(400);
    expect(second.body.error).toContain("used");
    const sessions = harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {
      n: number;
    };
    expect(sessions.n).toBe(1);
  });

  it("rejects an unknown token", async () => {
    const response = await harness.request
      .post("/api/auth/redeem")
      .send({ token: "deadbeef".repeat(8) });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("unknown");
  });
});

describe("session enforcement", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("rejects unauthenticated requests to every non-health endpoint", async () => {
    const requests = [
      () => harness.request.get("/api/auth/me"),
      () => harness.request.get("/api/users"),
      () => harness.request.post("/api/auth/logout"),
      () => harness.request.get("/api/not-a-route-yet"),
    ];

    for (const make of requests) {
      const response = await make();
      expect(response.status).toBe(401);
      expect(response.body.error).toContain("authentication required");
    }
  });

  it("keeps /health open without a session", async () => {
    const response = await harness.request.get("/health");
    expect(response.status).toBe(200);
  });
});

describe("POST /api/auth/logout", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("deletes the session, clears the cookie, and ends the login", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    const response = await agent.post("/api/auth/logout");

    expect(response.status).toBe(204);
    const sessions = harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {
      n: number;
    };
    expect(sessions.n).toBe(0);

    const setCookie = response.headers["set-cookie"] as string | string[] | undefined;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) as string;
    expect(cookie).toContain("session=");
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970");

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(401);
  });
});

describe("email plug selection (Resend when RESEND_KEY is set)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  function withResendKey<T>(body: () => Promise<T>): Promise<T> {
    // Pin the env around createApp exactly as the harness pins its own keys:
    // set, run, restore — no lingering process.env mutation.
    const previous = process.env.RESEND_KEY;
    process.env.RESEND_KEY = "test-resend-key";
    return body().finally(() => {
      if (previous === undefined) {
        delete process.env.RESEND_KEY;
      } else {
        process.env.RESEND_KEY = previous;
      }
    });
  }

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

  it("uses RESEND_FROM as the sender when it is set", async () => {
    const previousFrom = process.env.RESEND_FROM;
    process.env.RESEND_FROM = "RMS <no-reply@example.com.com>";
    try {
      await withResendKey(async () => {
        const calls = stubFetch([{ status: 200, body: { id: "email-id" } }]);
        const resendHarness = createTestHarness();
        try {
          const response = await resendHarness.request
            .post("/api/auth/request-link")
            .send({ email: MANAGER });
          expect(response.status).toBe(202);
          const body = JSON.parse(String(calls[0].init.body)) as { from: string };
          expect(body.from).toBe("RMS <no-reply@example.com.com>");
        } finally {
          resendHarness.close();
        }
      });
    } finally {
      if (previousFrom === undefined) {
        delete process.env.RESEND_FROM;
      } else {
        process.env.RESEND_FROM = previousFrom;
      }
    }
    vi.unstubAllGlobals();
  });

  it("sends the login link through Resend when RESEND_KEY is set", async () => {
    await withResendKey(async () => {
      const calls = stubFetch([{ status: 200, body: { id: "email-id" } }]);
      const resendHarness = createTestHarness();
      try {
        // loginAs() reads the console plug's outbox, which doesn't exist when
        // Resend is live — extract the link from the email body instead.
        const requestLink = await resendHarness.request
          .post("/api/auth/request-link")
          .send({ email: MANAGER });
        expect(requestLink.status).toBe(202);

        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://api.resend.com/emails");
        const headers = calls[0].init.headers as Record<string, string>;
        expect(headers["authorization"]).toBe("Bearer test-resend-key");
        const body = JSON.parse(String(calls[0].init.body)) as {
          from: string;
          to: string;
          subject: string;
          text: string;
        };
        expect(body.from).toContain("onboarding@resend.com");
        expect(body.to).toBe(MANAGER);
        expect(body.subject).toContain("login");
        const linkUrl = body.text.match(/https?:\/\/\S+/)?.[0];
        expect(linkUrl).toContain("/redeem?token=");

        // the delivered link really logs the user in
        const token = new URL(linkUrl as string).searchParams.get("token");
        const redeem = await resendHarness.request.post("/api/auth/redeem").send({ token });
        expect(redeem.status).toBe(200);
        expect(redeem.body).toEqual({ id: expect.any(Number), email: MANAGER, role: "manager" });
      } finally {
        resendHarness.close();
      }
    });
    vi.unstubAllGlobals();
  });

  it("fails loudly — and sends nothing — when Resend rejects the send", async () => {
    await withResendKey(async () => {
      stubFetch([
        {
          status: 403,
          body: {
            name: "validation_error",
            message: "You can only send testing emails to your own email address",
          },
        },
      ]);
      const resendHarness = createTestHarness();
      try {
        const response = await resendHarness.request
          .post("/api/auth/request-link")
          .send({ email: MANAGER });
        expect(response.status).toBe(500);
        expect(response.body.error).toContain("Resend");
        expect(response.body.error).toContain("own email address");
      } finally {
        resendHarness.close();
      }
    });
    vi.unstubAllGlobals();
  });
});
