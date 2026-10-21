import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import { createTestHarness, DEFAULT_MANAGER_EMAIL, type TestHarness } from "./harness.js";
import {
  envValues,
  parseEnvLines,
  renderEnvLines,
  withEnvValue,
  type EnvLine,
} from "../domains/admin/envfile.js";
import { RESTART_CONFIRMATION_PHRASE } from "../domains/admin/index.js";

/**
 * Ticket 22 — the admin panel's owner tools: the .env editor (masked secrets,
 * preserved comments/unknown keys, guarded writes, pending-restart honesty),
 * the restart button (typed confirmation + the explicit supervision gate),
 * and the API console (self-dispatch AS the first active manager, same-app
 * guards, verbatim responses).
 */

const ADMIN_KEY = "test-admin-key";
const MANAGER = DEFAULT_MANAGER_EMAIL;
const SECRET = "resend_sk_1234567890abcd";

interface HarnessHandle {
  harness: TestHarness;
  admin: ReturnType<typeof supertest.agent>;
}

async function withAdmin(): Promise<HarnessHandle> {
  const harness = createTestHarness({ adminKey: ADMIN_KEY });
  const admin = supertest.agent(harness.app);
  const response = await admin.post("/api/admin/session").send({ key: ADMIN_KEY });
  expect(response.status).toBe(204);
  return { harness, admin };
}

/**
 * Points RMS_ENV_FILE at a throwaway file for the duration of a callback —
 * the documented test seam; envfile.ts reads the override at call time.
 */
async function withEnvFile<T>(harness: TestHarness, body: string, run: () => Promise<T>): Promise<T> {
  const file = path.join(path.dirname(harness.dbPath), "test.env");
  fs.writeFileSync(file, body);
  const previous = process.env.RMS_ENV_FILE;
  process.env.RMS_ENV_FILE = file;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.RMS_ENV_FILE;
    } else {
      process.env.RMS_ENV_FILE = previous;
    }
  }
}

/** Pins environment variables around one awaited request, restoring after. */
async function withPinnedEnv<T>(pins: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
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

const ENV_FILE_BODY = [
  "# repair-inventory settings",
  "APP_ORIGIN=http://localhost:3000",
  "ALLOWED_EMAIL_DOMAINS=@acme.co,@acme.com",
  "",
  "# a hand-written note the editor must never eat",
  "UNKNOWN_KEY=keep me",
  `ADMIN_KEY=${SECRET}`,
].join("\n");

describe("envfile mechanics", () => {
  it("round-trips comments, blank lines, and unknown keys untouched", () => {
    const parsed = parseEnvLines(ENV_FILE_BODY);
    expect(renderEnvLines(parsed)).toBe(ENV_FILE_BODY);
    expect(envValues(parsed).get("UNKNOWN_KEY")).toBe("keep me");
    expect(envValues(parsed).get("ADMIN_KEY")).toBe(SECRET);
  });

  it("parses the quoting forms Node's loadEnvFile accepts", () => {
    const text = [
      "A=plain value",
      "B='single $LITERAL #hash'",
      'C="two\\nlines"',
      "D=",
      "export E=exported",
      "F=trailing # comment",
    ].join("\n");
    const values = envValues(parseEnvLines(text));
    expect(values.get("A")).toBe("plain value");
    expect(values.get("B")).toBe("single $LITERAL #hash");
    expect(values.get("C")).toBe("two\nlines");
    expect(values.get("D")).toBe("");
    expect(values.get("E")).toBe("exported");
    expect(values.get("F")).toBe("trailing");
  });

  it("edits a key in place and appends an unknown-to-the-file key at the end", () => {
    const edited = withEnvValue(parseEnvLines(ENV_FILE_BODY), "APP_ORIGIN", "http://localhost:5173");
    const rendered = renderEnvLines(edited);
    // Position kept (first assignment), the comment above untouched.
    expect(rendered).toContain("# repair-inventory settings\nAPP_ORIGIN=http://localhost:5173");
    expect(rendered).toContain("UNKNOWN_KEY=keep me");
    expect(rendered).toContain(`ADMIN_KEY=${SECRET}`);

    const appended = withEnvValue(parseEnvLines(ENV_FILE_BODY), "RESEND_FROM", "RMS <no-reply@example.com>");
    expect(renderEnvLines(appended).endsWith("RESEND_FROM=RMS <no-reply@example.com>")).toBe(true);
  });

  it("quotes values so Node reads back exactly what was written", () => {
    for (const value of [
      "plain",
      "with spaces",
      "hash # inside",
      'say "hi"',
      "it's",
      "RMS <no-reply@example.com>",
      "",
    ]) {
      const line = withEnvValue([], "KEY", value)[0] as Extract<EnvLine, { kind: "entry" }>;
      const round = envValues(parseEnvLines(`${line.rawLines[0]}\n`)).get("KEY");
      expect(round, JSON.stringify(value)).toBe(value);
    }
  });

  it("refuses values it cannot represent instead of mangling them", () => {
    expect(() => withEnvValue([], "KEY", "both ' and \" quotes")).toThrow();
    expect(() => withEnvValue([], "KEY", "line\nbreak")).toThrow();
  });
});

describe("admin .env editor", () => {
  let ctx: HarnessHandle;
  beforeEach(async () => {
    ctx = await withAdmin();
  });
  afterEach(() => ctx.harness.close());

  it("lists the catalog with secrets masked — the full secret never leaves the server", async () => {
    await withEnvFile(ctx.harness, ENV_FILE_BODY, async () => {
      const response = await ctx.admin.get("/api/admin/env");
      expect(response.status).toBe(200);
      const entries = response.body.entries as Array<{
        key: string;
        editable: boolean;
        secret: boolean;
        value: string;
        reason?: string;
      }>;
      const keys = entries.map((entry) => entry.key);
      expect(keys).toEqual([
        "APP_ORIGIN",
        "RESEND_KEY",
        "RESEND_FROM",
        "ADMIN_KEY",
        "ALLOWED_EMAIL_DOMAINS",
        "DB_PATH",
        "PORT",
      ]);
      const adminKey = entries.find((entry) => entry.key === "ADMIN_KEY")!;
      expect(adminKey.editable).toBe(true);
      expect(adminKey.secret).toBe(true);
      // Masked: only the last four characters, never the whole value.
      expect(adminKey.value).toBe("(set ····abcd)");
      expect(JSON.stringify(response.body)).not.toContain(SECRET);

      const nonSecret = entries.find((entry) => entry.key === "APP_ORIGIN")!;
      expect(nonSecret.value).toBe("http://localhost:3000");
      const readOnly = entries.find((entry) => entry.key === "DB_PATH")!;
      expect(readOnly.editable).toBe(false);
      expect(readOnly.reason).toContain("empty database");
    });
  });

  it("marks entries pending-restart when the file differs from the live process.env", async () => {
    await withEnvFile(ctx.harness, ENV_FILE_BODY, async () => {
      // Pin the live env to match the file (as it would right after startup).
      await withPinnedEnv(
        { APP_ORIGIN: "http://localhost:3000", ADMIN_KEY: SECRET },
        async () => {
          const before = await ctx.admin.get("/api/admin/env");
          expect(before.body.restartRequired).toBe(false);
          expect(
            (before.body.entries as Array<{ key: string; pendingRestart: boolean }>).every(
              (entry) => !entry.pendingRestart
            )
          ).toBe(true);
        }
      );

      await withPinnedEnv({ APP_ORIGIN: "http://localhost:5173" }, async () => {
        const after = await ctx.admin.get("/api/admin/env");
        const entry = (after.body.entries as Array<{ key: string; pendingRestart: boolean }>).find(
          (candidate) => candidate.key === "APP_ORIGIN"
        )!;
        expect(entry.pendingRestart).toBe(true);
        expect(after.body.restartRequired).toBe(true);
        // The flag is a boolean only — the live value is not sent.
        expect(JSON.stringify(after.body)).not.toContain("http://localhost:5173");
      });
    });
  });

  it("refuses read-only keys loudly with the reason", async () => {
    await withEnvFile(ctx.harness, ENV_FILE_BODY, async () => {
      const response = await ctx.admin
        .put("/api/admin/env")
        .send({ key: "DB_PATH", value: "somewhere/else.sqlite" });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("read-only");
      expect(response.body.error).toContain("empty database");
      // The file is untouched.
      expect(fs.readFileSync(process.env.RMS_ENV_FILE!, "utf8")).toBe(ENV_FILE_BODY);
    });
  });

  it("refuses an unknown key", async () => {
    await withEnvFile(ctx.harness, ENV_FILE_BODY, async () => {
      const unknown = await ctx.admin.put("/api/admin/env").send({ key: "MYSTERY", value: "x" });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toContain("unknown");
      expect(fs.readFileSync(process.env.RMS_ENV_FILE!, "utf8")).toBe(ENV_FILE_BODY);
    });
  });

  it("treats an empty secret as no change", async () => {
    await withEnvFile(ctx.harness, ENV_FILE_BODY, async () => {
      const response = await ctx.admin.put("/api/admin/env").send({ key: "ADMIN_KEY", value: "" });
      expect(response.status).toBe(200);
      expect(response.body.changed).toBe(false);
      expect(fs.readFileSync(process.env.RMS_ENV_FILE!, "utf8")).toBe(ENV_FILE_BODY);
    });
  });

  it("writes an edit atomically to the file and says the change needs a restart", async () => {
    await withEnvFile(ctx.harness, ENV_FILE_BODY, async () => {
      const response = await ctx.admin
        .put("/api/admin/env")
        .send({ key: "RESEND_FROM", value: "RMS <no-reply@example.com>" });
      expect(response.status).toBe(200);
      expect(response.body.changed).toBe(true);
      expect(response.body.restartRequired).toBe(true);
      expect(String(response.body.message)).toContain("restart");

      const rendered = fs.readFileSync(process.env.RMS_ENV_FILE!, "utf8");
      expect(rendered).toContain("RESEND_FROM=RMS <no-reply@example.com>");
      // Everything the owner had in the file survives the edit.
      expect(rendered).toBe(
        [
          "# repair-inventory settings",
          "APP_ORIGIN=http://localhost:3000",
          "ALLOWED_EMAIL_DOMAINS=@acme.co,@acme.com",
          "",
          "# a hand-written note the editor must never eat",
          "UNKNOWN_KEY=keep me",
          `ADMIN_KEY=${SECRET}`,
          "RESEND_FROM=RMS <no-reply@example.com>",
        ].join("\n")
      );

      // The edited non-secret now reads back with the pending flag set.
      const after = await ctx.admin.get("/api/admin/env");
      const entry = (after.body.entries as Array<{ key: string; pendingRestart: boolean }>).find(
        (candidate) => candidate.key === "RESEND_FROM"
      )!;
      expect(entry.pendingRestart).toBe(true);
    });
  });

  it("edits a secret (masked in the response) and never logs or returns its value", async () => {
    await withEnvFile(ctx.harness, ENV_FILE_BODY, async () => {
      const newSecret = "sk_live_newSecretValue99";
      const response = await ctx.admin.put("/api/admin/env").send({ key: "RESEND_KEY", value: newSecret });
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain(newSecret);
      expect(fs.readFileSync(process.env.RMS_ENV_FILE!, "utf8")).toContain(`RESEND_KEY=${newSecret}`);
    });
  });

  it("refuses a value that cannot be stored in the .env file", async () => {
    await withEnvFile(ctx.harness, ENV_FILE_BODY, async () => {
      const response = await ctx.admin
        .put("/api/admin/env")
        .send({ key: "APP_ORIGIN", value: "both ' and \" quotes" });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("cannot be stored");
      expect(fs.readFileSync(process.env.RMS_ENV_FILE!, "utf8")).toBe(ENV_FILE_BODY);
    });
  });
});

describe("restart gate and button", () => {
  let ctx: HarnessHandle;
  beforeEach(async () => {
    ctx = await withAdmin();
  });
  afterEach(() => ctx.harness.close());

  it("refuses by default: npm start has no supervisor", async () => {
    await withPinnedEnv({ npm_lifecycle_event: undefined, ALLOW_RESTART: undefined }, async () => {
      const state = await ctx.admin.get("/api/admin/restart");
      expect(state.status).toBe(200);
      expect(state.body).toMatchObject({ allowed: false, mode: "refused" });
      expect(state.body.explanation).toContain("ALLOW_RESTART=true");

      const response = await ctx.admin
        .post("/api/admin/restart")
        .send({ confirmation: RESTART_CONFIRMATION_PHRASE });
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("supervisor");
    });
  });

  it("reports the supervised state when ALLOW_RESTART=true acknowledges a supervisor", async () => {
    await withPinnedEnv({ npm_lifecycle_event: undefined, ALLOW_RESTART: "true" }, async () => {
      const state = await ctx.admin.get("/api/admin/restart");
      expect(state.body).toMatchObject({ allowed: true, mode: "supervised" });
    });
  });

  it("requires the exact typed confirmation phrase", async () => {
    await withPinnedEnv({ npm_lifecycle_event: undefined, ALLOW_RESTART: undefined }, async () => {
      const wrong = await ctx.admin.post("/api/admin/restart").send({ confirmation: "restart" });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toContain(RESTART_CONFIRMATION_PHRASE);
    });
  });

  it("responds 200 first, then exits the process (dev supervision restarts it)", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await withPinnedEnv({ npm_lifecycle_event: "dev", ALLOW_RESTART: undefined }, async () => {
        const state = await ctx.admin.get("/api/admin/restart");
        expect(state.body).toMatchObject({ allowed: true, mode: "dev" });

        const response = await ctx.admin
          .post("/api/admin/restart")
          .send({ confirmation: RESTART_CONFIRMATION_PHRASE });
        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(String(response.body.message)).toContain("admin");
        // Respond-then-exit: the process is gone shortly after the response.
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(exit).toHaveBeenCalledWith(0);
      });
    } finally {
      exit.mockRestore();
    }
  });
});

describe("API console", () => {
  let ctx: HarnessHandle;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    ctx = await withAdmin();
    // The console self-fetches over real HTTP (127.0.0.1:<port>); give the
    // harness app a real listener and pin PORT the way server/index.ts reads it.
    server = http.createServer(ctx.harness.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
    ctx.harness.close();
  });

  /** Sends one console request with PORT pinned. */
  async function dispatch(body: Record<string, unknown>) {
    return withPinnedEnv({ PORT: String(port) }, () =>
      ctx.admin.post("/api/admin/api-console").send(body)
    );
  }

  it("runs a manager-only endpoint as the first active manager, with the event carrying them as actor", async () => {
    const response = await dispatch({
      method: "POST",
      path: "/api/skus",
      body: { name: "Console SKU", price: "7.00", kind: "serialized" },
    });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe(201);

    // The manager identity: the created SKU's event names the manager as actor.
    const manager = ctx.harness.db.prepare("SELECT id FROM users WHERE email = ?").get(MANAGER) as {
      id: number;
    };
    const event = ctx.harness.db
      .prepare("SELECT actor_id FROM events WHERE action = 'sku.created' ORDER BY id DESC LIMIT 1")
      .get() as { actor_id: number };
    expect(event.actor_id).toBe(manager.id);

    // One console call = one ephemeral session: removed after the dispatch.
    const sessions = ctx.harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as {
      n: number;
    };
    expect(sessions.n).toBe(0);
  });

  it("refuses paths outside this app, path traversal, and non-allowed methods", async () => {
    const outside = await dispatch({ method: "GET", path: "https://example.com/api/skus" });
    expect(outside.status).toBe(400);
    expect(outside.body.error).toContain("same-app");

    const traversal = await dispatch({ method: "GET", path: "/api/../admin/sql" });
    expect(traversal.status).toBe(400);

    const method = await dispatch({ method: "TRACE", path: "/api/skus" });
    expect(method.status).toBe(400);
  });

  it("refuses a body that is not a JSON object", async () => {
    const response = await dispatch({ method: "POST", path: "/api/skus", body: "not json" });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("JSON object");
  });

  it("refuses to run when no active manager or admin exists", async () => {
    // There is no bootstrap manager anymore: with every user DEACTIVATED
    // (as after a wipe leaves them gone), the console has nobody to run as —
    // the Users section of the panel creates one first.
    ctx.harness.db.prepare("UPDATE users SET active = 0").run();
    const response = await withPinnedEnv({ PORT: String(port) }, () =>
      ctx.admin.post("/api/admin/api-console").send({ method: "GET", path: "/health" })
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("no active manager or admin exists");
    // Restore: this describe shares one harness across its tests.
    ctx.harness.db.prepare("UPDATE users SET active = 1").run();
  });

  it("passes non-2xx responses through verbatim instead of hiding them", async () => {
    // A validation failure inside the app (JSON error body)...
    const badSku = await dispatch({ method: "POST", path: "/api/skus", body: { name: "" } });
    expect(badSku.status).toBe(200);
    expect(badSku.body.status).toBe(400);
    expect(badSku.body.body.error).toBeTruthy();
    // ...and an unknown route (text 404 body) both come back as-is.
    const notFound = await dispatch({ method: "GET", path: "/api/no-such-route" });
    expect(notFound.status).toBe(200);
    expect(notFound.body.status).toBe(404);
    expect(String(notFound.body.body)).toContain("Cannot GET");
  });

  it("dispatches /health and returns JSON bodies parsed", async () => {
    const response = await dispatch({ method: "GET", path: "/health" });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe(200);
    expect(response.body.body.status).toBe("ok");
  });
});
