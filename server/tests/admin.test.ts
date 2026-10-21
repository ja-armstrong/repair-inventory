import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import type { Express } from "express";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type TestHarness,
} from "./harness.js";
import { openDatabase } from "../db/connection.js";
import { knownMigrationNames } from "../db/migrate.js";
import { applyPendingRestore, validateBackupFile } from "../domains/admin/backups.js";
import { PROD_STAGED_RESTORE } from "../domain.js";
import {
  CLEAR_CONFIRMATION_PHRASE,
  WRITE_MODE_CONFIRMATION_PHRASE,
} from "../domains/admin/index.js";

/**
 * Ticket 18 — the admin panel at the seam: the auth gate (unset key → 404
 * everywhere; wrong key → 401; right key → in; main-app sessions grant
 * nothing), the settings editor's validation, backup creation, the
 * backup-then-clear ordering, restore validation + the staged swap, the SQL
 * console's read-only default, and system info.
 */

const ADMIN_KEY = "test-admin-key";
const MANAGER = DEFAULT_MANAGER_EMAIL;

// The number of migrations on disk — asserted as "every migration applied"
// rather than a literal, so adding a migration file never re-breaks these.
const MIGRATION_COUNT = knownMigrationNames().length;

interface HarnessHandle {
  harness: TestHarness;
  /** supertest agent carrying the admin cookie. */
  admin: ReturnType<typeof supertest.agent>;
}

function backupsDirOf(harness: TestHarness): string {
  return path.join(path.dirname(harness.dbPath), "backups");
}

function listBackups(harness: TestHarness): string[] {
  const dir = backupsDirOf(harness);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

async function openAdminSession(harness: TestHarness): Promise<HarnessHandle> {
  const admin = supertest.agent(harness.app);
  const response = await admin.post("/api/admin/session").send({ key: ADMIN_KEY });
  expect(response.status).toBe(204);
  return { harness, admin };
}

/** Harness + logged-in admin session, for everything past the auth gate. */
async function withAdmin(options: { now?: Date | string } = {}): Promise<HarnessHandle> {
  const harness = createTestHarness({ adminKey: ADMIN_KEY, ...options });
  return openAdminSession(harness);
}

/**
 * A main-app manager agent for data SETUP (SKUs, users) — the admin cookie
 * grants nothing on /api, and the main session grants nothing on /api/admin;
 * the two surfaces are exercised by separate agents on purpose.
 */
async function managerAgentFor(harness: TestHarness) {
  const manager = await harness.loginAs(MANAGER);
  return manager.agent;
}

describe("admin auth gate", () => {
  // Unset key: the whole surface is indistinguishable from nonexistent.
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness();
  });
  afterEach(() => harness.close());

  it("answers 404 on every /api/admin route when ADMIN_KEY is unset", async () => {
    const paths: Array<[string, string]> = [
      ["get", "/api/admin/session"],
      ["post", "/api/admin/session"],
      ["get", "/api/admin/settings"],
      ["get", "/api/admin/backup"],
      ["post", "/api/admin/clear"],
      ["post", "/api/admin/restore"],
      ["post", "/api/admin/sql"],
      ["get", "/api/admin/system"],
    ];
    for (const [method, url] of paths) {
      const response =
        method === "get" ? await harness.request.get(url) : await harness.request.post(url);
      expect(response.status, `${method.toUpperCase()} ${url}`).toBe(404);
    }
  });

  it("still answers 404 for unknown admin subpaths (no info leak either way)", async () => {
    const response = await harness.request.get("/api/admin/anything");
    expect(response.status).toBe(404);
  });
});

describe("admin session (key auth)", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness({ adminKey: ADMIN_KEY });
  });
  afterEach(() => harness.close());

  it("rejects unauthenticated access with 401 and no detail", async () => {
    const response = await harness.request.get("/api/admin/settings");
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("admin authentication required");
  });

  it("a main-app session grants nothing on /api/admin", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent.get("/api/admin/settings");
    expect(response.status).toBe(401);
  });

  it("a wrong key is refused 401; the right key opens a session; logout closes it", async () => {
    const wrong = await harness.request.post("/api/admin/session").send({ key: "not-the-key" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("invalid admin key");

    const agent = supertest.agent(harness.app);
    const open = await agent.post("/api/admin/session").send({ key: ADMIN_KEY });
    expect(open.status).toBe(204);
    const check = await agent.get("/api/admin/session");
    expect(check.status).toBe(200);
    expect(check.body).toEqual({ ok: true });

    const out = await agent.delete("/api/admin/session");
    expect(out.status).toBe(204);
    expect((await agent.get("/api/admin/session")).status).toBe(401);
  });

  it("a missing key body is a 400, not a counted failure", async () => {
    const response = await harness.request.post("/api/admin/session").send({});
    expect(response.status).toBe(400);
  });

  it("blunts brute force: the sixth failed attempt inside a minute is 429", async () => {
    const agent = supertest.agent(harness.app);
    for (let attempt = 0; attempt < 5; attempt++) {
      const failure = await agent.post("/api/admin/session").send({ key: `wrong-${attempt}` });
      expect(failure.status).toBe(401);
    }
    // Even the CORRECT key is refused inside the window.
    const sixth = await agent.post("/api/admin/session").send({ key: ADMIN_KEY });
    expect(sixth.status).toBe(429);
  });
});

describe("admin settings editor", () => {
  let ctx: HarnessHandle;
  beforeEach(async () => {
    ctx = await withAdmin();
  });
  afterEach(() => ctx.harness.close());

  it("lists every defined setting with its value, minimum, and default", async () => {
    const response = await ctx.admin.get("/api/admin/settings");
    expect(response.status).toBe(200);
    const keys = (response.body.settings as Array<{ key: string }>).map((setting) => setting.key);
    expect(keys).toEqual([
      "price_expiry_days",
      "audit_interval_months",
      "label_width_sixteenths",
      "label_height_sixteenths",
      "dymo_printer_name",
    ]);
    expect(response.body.settings[0]).toMatchObject({ key: "price_expiry_days", value: "90", min: 1 });
  });

  it("updates a setting, records setting.updated on the timeline, and the value sticks", async () => {
    const response = await ctx.admin
      .patch("/api/admin/settings")
      .send({ key: "price_expiry_days", value: "45" });
    expect(response.status).toBe(200);
    const updated = (response.body.settings as Array<{ key: string; value: string }>).find(
      (setting) => setting.key === "price_expiry_days"
    );
    expect(updated?.value).toBe("45");

    const event = ctx.harness.db
      .prepare(
        "SELECT payload FROM events WHERE action = 'setting.updated' ORDER BY id DESC LIMIT 1"
      )
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      key: "price_expiry_days",
      from: "90",
      to: "45",
    });
  });

  it("rejects invalid values loudly with the reason", async () => {
    for (const value of ["0", "-3", "1.5", "abc", ""]) {
      const response = await ctx.admin
        .patch("/api/admin/settings")
        .send({ key: "price_expiry_days", value });
      expect(response.status, `value ${JSON.stringify(value)}`).toBe(400);
      expect(response.body.error).toBe("price_expiry_days must be a whole number of at least 1");
    }
    const unknown = await ctx.admin
      .patch("/api/admin/settings")
      .send({ key: "not_a_setting", value: "5" });
    expect(unknown.status).toBe(400);
  });

  // Ticket 19: the DYMO printer choice is the first string-typed setting;
  // the admin editor must round-trip it verbatim and refuse over-long text.
  it("round-trips the dymo_printer_name text setting and enforces its max length", async () => {
    const response = await ctx.admin
      .patch("/api/admin/settings")
      .send({ key: "dymo_printer_name", value: "DYMO LabelWriter 450" });
    expect(response.status).toBe(200);
    const updated = (response.body.settings as Array<{ key: string; value: string }>).find(
      (setting) => setting.key === "dymo_printer_name"
    );
    expect(updated?.value).toBe("DYMO LabelWriter 450");

    const tooLong = await ctx.admin
      .patch("/api/admin/settings")
      .send({ key: "dymo_printer_name", value: "x".repeat(201) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe("dymo_printer_name must be at most 200 characters");
  });
});

describe("backup download", () => {
  let ctx: HarnessHandle;
  let manager: ReturnType<typeof supertest.agent>;
  beforeAll(async () => {
    ctx = await withAdmin();
    manager = await managerAgentFor(ctx.harness);
  });
  afterAll(() => ctx.harness.close());

  it("streams a timestamped backup AND saves it under data/backups, consistent with live data", async () => {
    const created = await manager.post("/api/skus").send({
      name: "Backup Probe Screen",
      price: "10.00",
      kind: "serialized",
    });
    expect(created.status).toBe(201);

    const response = await ctx.admin.get("/api/admin/backup");
    expect(response.status).toBe(200);
    const disposition = response.headers["content-disposition"] as string;
    expect(disposition).toMatch(/attachment; filename="repair-inventory-\d{8}-\d{6}\.sqlite"/);

    const saved = listBackups(ctx.harness).filter((name) => name.startsWith("repair-inventory-"));
    expect(saved).toHaveLength(1);
    const validation = validateBackupFile(path.join(backupsDirOf(ctx.harness), saved[0]));
    expect(validation).toEqual({ ok: true });

    // The backup file itself carries the data that existed at backup time.
    const snapshot = openDatabase(path.join(backupsDirOf(ctx.harness), saved[0]));
    try {
      const row = snapshot
        .prepare("SELECT name FROM skus WHERE name = 'Backup Probe Screen'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("Backup Probe Screen");
    } finally {
      snapshot.close();
    }
  });
});

describe("clear the database", () => {
  let harness: TestHarness;
  let admin: ReturnType<typeof supertest.agent>;
  let manager: ReturnType<typeof supertest.agent>;
  beforeAll(async () => {
    const opened = await withAdmin();
    harness = opened.harness;
    admin = opened.admin;
    manager = await managerAgentFor(harness);
  });
  afterAll(() => harness.close());

  it("refuses anything but the exact confirmation phrase", async () => {
    const missing = await admin.post("/api/admin/clear").send({});
    expect(missing.status).toBe(400);
    const wrong = await admin
      .post("/api/admin/clear")
      .send({ confirmation: "erase all data" }); // case matters — typed, not clicked
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain(CLEAR_CONFIRMATION_PHRASE);
  });

  it("backs up BEFORE wiping: the backup holds pre-clear data, the live database starts fresh with ZERO users", async () => {
    // Data that must survive only in the backup.
    await manager.post("/api/skus").send({ name: "Doomed Screen", price: "5.00", kind: "serialized" });
    await harness.createUserAs("doomed@acme.co", "tech");

    const response = await admin
      .post("/api/admin/clear")
      .send({ confirmation: CLEAR_CONFIRMATION_PHRASE });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    const backupFilename = response.body.backup as string;
    expect(backupFilename).toMatch(/^repair-inventory-\d{8}-\d{6}\.sqlite$/);
    expect(listBackups(harness)).toContain(backupFilename);
    // The honest state of a wiped system: no users at all — the owner
    // recreates them in the Users section (the panel IS the bootstrap now).
    expect(String(response.body.note)).toContain("Create your users");

    // The backup contains what existed before the wipe (backup-then-clear order).
    const snapshot = openDatabase(path.join(backupsDirOf(harness), backupFilename));
    try {
      const doomed = snapshot.prepare("SELECT name FROM skus WHERE name = 'Doomed Screen'").get();
      expect(doomed).toBeTruthy();
      const doomedUser = snapshot
        .prepare("SELECT email FROM users WHERE email = 'doomed@acme.co'")
        .get();
      expect(doomedUser).toBeTruthy();
    } finally {
      snapshot.close();
    }

    // The live database is fresh: schema rebuilt by the migration runner,
    // settings reseeded, and ZERO users — recovery is the admin panel's job.
    const applied = harness.db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number };
    expect(applied.n).toBe(MIGRATION_COUNT);
    expect((harness.db.prepare("SELECT COUNT(*) AS n FROM skus").get() as { n: number }).n).toBe(0);
    const setting = harness.db
      .prepare("SELECT value FROM app_settings WHERE key = 'price_expiry_days'")
      .get() as { value: string };
    expect(setting.value).toBe("90"); // reseeded default, not a leftover
    expect((harness.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(0);
    const sessions = harness.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(sessions.n).toBe(0);
  });
});

describe("backup filename uniqueness", () => {
  // Same-second collision hazard (final review F4): the pre-action backup IS
  // the safety net in the danger zone, so two backups within one second must
  // never overwrite each other on disk.
  let ctx: HarnessHandle;
  beforeAll(async () => {
    ctx = await withAdmin();
  });
  afterAll(() => ctx.harness.close());

  it("two backups inside the same second produce two distinct, valid files", async () => {
    const manager = await managerAgentFor(ctx.harness);
    const first = await ctx.admin.get("/api/admin/backup");
    expect(first.status).toBe(200);

    // Data that only the SECOND snapshot may contain — proves the first
    // file was not silently replaced.
    await manager.post("/api/skus").send({ name: "Second Backup SKU", price: "1.00", kind: "serialized" });
    const second = await ctx.admin.get("/api/admin/backup");
    expect(second.status).toBe(200);

    const saved = listBackups(ctx.harness).filter((name) => name.startsWith("repair-inventory-"));
    expect(saved).toHaveLength(2);
    expect(new Set(saved).size).toBe(2);
    // First backup of the second keeps the plain stamp; the collision gets
    // an incrementing suffix.
    const plain = saved.filter((name) => /^repair-inventory-\d{8}-\d{6}\.sqlite$/.test(name));
    const suffixed = saved.filter((name) => /^repair-inventory-\d{8}-\d{6}-2\.sqlite$/.test(name));
    expect(plain).toHaveLength(1);
    expect(suffixed).toHaveLength(1);
    for (const name of saved) {
      expect(validateBackupFile(path.join(backupsDirOf(ctx.harness), name))).toEqual({ ok: true });
    }

    const firstSnapshot = openDatabase(path.join(backupsDirOf(ctx.harness), plain[0]));
    const secondSnapshot = openDatabase(path.join(backupsDirOf(ctx.harness), suffixed[0]));
    try {
      const inFirst = firstSnapshot.prepare("SELECT name FROM skus WHERE name = 'Second Backup SKU'").get();
      const inSecond = secondSnapshot.prepare("SELECT name FROM skus WHERE name = 'Second Backup SKU'").get();
      expect(inFirst).toBeUndefined();
      expect(inSecond).toBeTruthy();
    } finally {
      firstSnapshot.close();
      secondSnapshot.close();
    }
  });
});

describe("a wiped database is unlocked through the panel itself", () => {
  // There is no bootstrap manager anymore: the admin panel IS the recovery
  // path. After a wipe (zero users), the owner creates a user in the panel,
  // mints their login link, and the user logs in through the normal redeem
  // flow — the whole bootstrap, end to end.
  let harness: TestHarness;
  let admin: ReturnType<typeof supertest.agent>;
  beforeAll(async () => {
    const opened = await withAdmin();
    harness = opened.harness;
    admin = opened.admin;
  });
  afterAll(() => harness.close());

  it("create user → mint login link → redeem: the fresh system logs its first user in", async () => {
    // Wipe first (the danger-zone path): zero users, nothing to log in as.
    const cleared = await admin
      .post("/api/admin/clear")
      .send({ confirmation: CLEAR_CONFIRMATION_PHRASE });
    expect(cleared.status).toBe(200);
    expect((harness.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(0);

    const created = await admin.post("/api/admin/users").send({
      email: "owner@acme.co",
      role: "admin",
    });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ email: "owner@acme.co", role: "admin" });

    const linked = await admin.post("/api/admin/users/1/login-link").send({});
    expect(linked.status).toBe(201);
    expect(linked.body.loginUrl).toContain("/redeem?token=");
    expect(String(linked.body.note)).toContain("15 minutes");

    const token = new URL(linked.body.loginUrl as string).searchParams.get("token");
    const agent = supertest.agent(harness.app);
    const redeemed = await agent.post("/api/auth/redeem").send({ token });
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toMatchObject({ email: "owner@acme.co", role: "admin" });

    // The new admin has real powers immediately: they can manage users.
    const users = await agent.get("/api/users");
    expect(users.status).toBe(200);

    // The timeline records the panel-created user with no actor and the
    // panel as the how.
    const event = harness.db
      .prepare("SELECT actor_id, payload FROM events WHERE action = 'user.created' ORDER BY id DESC LIMIT 1")
      .get() as { actor_id: number | null; payload: string };
    expect(event.actor_id).toBeNull();
    expect(JSON.parse(event.payload)).toMatchObject({
      email: "owner@acme.co",
      role: "admin",
      via: "admin panel",
    });
  });

  it("a deactivated user's login link is refused until reactivation", async () => {
    const created = await admin.post("/api/admin/users").send({
      email: "temp@acme.co",
      role: "tech",
    });
    expect(created.status).toBe(201);
    const deactivated = await admin.patch("/api/admin/users/2/active").send({ active: false });
    expect(deactivated.status).toBe(200);

    const linked = await admin.post("/api/admin/users/2/login-link").send({});
    expect(linked.status).toBe(409);
    expect(linked.body.error).toContain("deactivated");

    const reactivated = await admin.patch("/api/admin/users/2/active").send({ active: true });
    expect(reactivated.status).toBe(200);
    expect((await admin.post("/api/admin/users/2/login-link").send({})).status).toBe(201);
  });
});

describe("restore from backup", () => {
  let harness: TestHarness;
  let admin: ReturnType<typeof supertest.agent>;
  let manager: ReturnType<typeof supertest.agent>;
  beforeAll(async () => {
    const opened = await withAdmin();
    harness = opened.harness;
    admin = opened.admin;
    manager = await managerAgentFor(harness);
  });
  afterAll(() => harness.close());

  async function upload(filename: string, body: Buffer | string) {
    return admin
      .post("/api/admin/restore")
      .query({ filename })
      .set("content-type", "application/octet-stream")
      .send(body);
  }

  it("refuses a non-SQLite upload loudly", async () => {
    const response = await upload("garbage.sqlite", "this is not a database at all");
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/file is not a database/);
    // The rejected upload leaves no debris in the backups directory.
    expect(listBackups(harness).filter((name) => name.startsWith("restore-upload-"))).toEqual([]);
  });

  it("refuses a database without a migrations table", async () => {
    const dir = path.dirname(harness.dbPath);
    const stranger = path.join(dir, "stranger.sqlite");
    const db = new Database(stranger);
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)");
    db.close();
    const response = await upload("stranger.sqlite", fs.readFileSync(stranger));
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("migrations table is missing");
  });

  it("refuses a database whose migration state is not a prefix of the known migrations", async () => {
    const dir = path.dirname(harness.dbPath);
    const future = path.join(dir, "future.sqlite");
    const db = new Database(future);
    db.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
      "0001-migrations-table.sql",
      "2026-01-01T00:00:00.000Z"
    );
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
      "9999-from-the-future.sql",
      "2026-01-02T00:00:00.000Z"
    );
    db.close();
    const response = await upload("future.sqlite", fs.readFileSync(future));
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("migration state mismatch at position 2");
  });

  it("accepts a prefix (an older backup) and stages the restore after backing up the current database", async () => {
    const dir = path.dirname(harness.dbPath);
    const old = path.join(dir, "old.sqlite");
    const db = new Database(old);
    db.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
      "0001-migrations-table.sql",
      "2026-01-01T00:00:00.000Z"
    );
    db.close();

    await manager.post("/api/skus").send({ name: "Current Data", price: "1.00", kind: "serialized" });
    const before = (harness.db.prepare("SELECT COUNT(*) AS n FROM skus").get() as { n: number }).n;

    const response = await upload("old.sqlite", fs.readFileSync(old));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, restartRequired: true });
    expect(response.body.backup).toMatch(/^repair-inventory-\d{8}-\d{6}\.sqlite$/);

    // Nothing has swapped yet: the live database keeps its data...
    expect((harness.db.prepare("SELECT COUNT(*) AS n FROM skus").get() as { n: number }).n).toBe(
      before
    );
    // ...the staged file and the marker exist...
    expect(listBackups(harness)).toContain(response.body.staged);
    expect(fs.existsSync(path.join(path.dirname(harness.dbPath), "pending-restore.json"))).toBe(
      true
    );
    // ...and the pre-restore backup of the current database exists.
    expect(
      listBackups(harness).some((name) => name.startsWith("repair-inventory-"))
    ).toBe(true);
  });

  it("refuses an empty body or a non-.sqlite filename", async () => {
    const noName = await admin
      .post("/api/admin/restore")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("anything"));
    expect(noName.status).toBe(400);
    const wrongName = await upload("backup.backup", Buffer.from("anything"));
    expect(wrongName.status).toBe(400);
  });
});

describe("restore swap at startup (applyPendingRestore)", () => {
  // This block manages its own lifecycle: the swap replaces the database file
  // under the process, so the harness's open handle must be closed by hand.
  let harness: TestHarness;
  let admin: ReturnType<typeof supertest.agent>;
  let manager: ReturnType<typeof supertest.agent>;

  beforeAll(async () => {
    const opened = await withAdmin();
    harness = opened.harness;
    admin = opened.admin;
    manager = await managerAgentFor(harness);
  });

  afterAll(async () => {
    try {
      harness.db.close();
    } catch {
      // already closed by the swap scenario below
    }
    // The sandbox instance's handle is unaffected by the prod-file swap, but
    // it must be closed before the temp directory can be deleted on Windows.
    harness.sandbox.db.close();
    fs.rmSync(path.dirname(harness.dbPath), { recursive: true, force: true });
  });

  it("stages a restore, then replaces the database at the next start — keeping the data from the staged file", async () => {
    // The state that goes INTO the backup...
    await manager.post("/api/skus").send({ name: "Survivor SKU", price: "2.00", kind: "serialized" });
    const backupResponse = await admin.get("/api/admin/backup");
    expect(backupResponse.status).toBe(200);
    const backupName = listBackups(harness).find((name) => name.startsWith("repair-inventory-"));
    expect(backupName).toBeDefined();
    const backupBytes = fs.readFileSync(path.join(backupsDirOf(harness), backupName!));

    // ...and a write made AFTER the backup, which the restore must discard.
    await manager.post("/api/skus").send({ name: "Post-backup SKU", price: "3.00", kind: "serialized" });

    const response = await admin
      .post("/api/admin/restore")
      .query({ filename: backupName! })
      .set("content-type", "application/octet-stream")
      .send(backupBytes);
    expect(response.status).toBe(200);

    // Simulate the restart: close the live handle, run the startup swap.
    harness.db.close();
    const marker = await applyPendingRestore(harness.dbPath, PROD_STAGED_RESTORE);
    // The marker records the auto-backup taken at staging time — with same-
    // second collision protection, that's a distinct file from the manual
    // backup made a moment earlier.
    expect(marker).toMatchObject({ file: response.body.staged, backup: response.body.backup });

    const restored = openDatabase(harness.dbPath);
    try {
      const names = (
        restored.prepare("SELECT name FROM skus ORDER BY name").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(names).toEqual(["Survivor SKU"]); // post-backup write is gone
      // The normal startup migration run then applies anything missing — here
      // the backup was fully current, so every migration is already recorded.
      expect((restored.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n).toBe(
        MIGRATION_COUNT
      );
    } finally {
      restored.close();
    }

    // Danger rule: the state being REPLACED was backed up at swap time too.
    expect(listBackups(harness).some((name) => name.startsWith("pre-restore-"))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(harness.dbPath), "pending-restore.json"))).toBe(
      false
    );

    // A second run with no marker pending is a no-op.
    expect(await applyPendingRestore(harness.dbPath, PROD_STAGED_RESTORE)).toBeUndefined();
  });
});

describe("SQL console", () => {
  let ctx: HarnessHandle;
  beforeEach(async () => {
    ctx = await withAdmin();
  });
  afterEach(() => ctx.harness.close());

  it("runs a SELECT by default and returns columns, rows, and a row count", async () => {
    const response = await ctx.admin.post("/api/admin/sql").send({ sql: "SELECT 1 AS one, 'x' AS x" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      columns: ["one", "x"],
      rows: [{ one: 1, x: "x" }],
      rowCount: 1,
    });
  });

  it("rejects non-SELECT statements while read-only", async () => {
    const update = await ctx.admin
      .post("/api/admin/sql")
      .send({ sql: "UPDATE app_settings SET value = '1' WHERE key = 'price_expiry_days'" });
    expect(update.status).toBe(400);
    expect(update.body.error).toContain("read-only console");

    const drop = await ctx.admin.post("/api/admin/sql").send({ sql: "DROP TABLE skus" });
    expect(drop.status).toBe(400);

    // The data is untouched.
    const setting = ctx.harness.db
      .prepare("SELECT value FROM app_settings WHERE key = 'price_expiry_days'")
      .get() as { value: string };
    expect(setting.value).toBe("90");
  });

  it("rejects chained statements and reports SQL errors verbatim", async () => {
    const chained = await ctx.admin
      .post("/api/admin/sql")
      .send({ sql: "SELECT 1; SELECT 2" });
    expect(chained.status).toBe(400);
    expect(chained.body.error).toContain("one statement at a time");

    const broken = await ctx.admin.post("/api/admin/sql").send({ sql: "SELECT * FROM no_such_table" });
    expect(broken.status).toBe(400);
    expect(broken.body.error).toContain("no such table: no_such_table");
  });

  it("allowWrite without the per-session toggle is 403", async () => {
    const response = await ctx.admin
      .post("/api/admin/sql")
      .send({ sql: "UPDATE app_settings SET value = '5' WHERE key = 'price_expiry_days'", allowWrite: true });
    expect(response.status).toBe(403);
    expect(response.body.error).toContain(WRITE_MODE_CONFIRMATION_PHRASE);
  });

  it("write mode requires the typed confirmation phrase", async () => {
    const wrong = await ctx.admin
      .post("/api/admin/sql/write-mode")
      .send({ confirmation: "allow writes" }); // case matters
    expect(wrong.status).toBe(400);
    expect((await ctx.admin.get("/api/admin/sql/write-mode")).body.writeMode).toBe(false);
  });

  it("a confirmed write mode executes writes after an automatic pre-write backup", async () => {
    const enable = await ctx.admin
      .post("/api/admin/sql/write-mode")
      .send({ confirmation: WRITE_MODE_CONFIRMATION_PHRASE });
    expect(enable.status).toBe(200);
    expect(enable.body).toEqual({ writeMode: true });

    const response = await ctx.admin
      .post("/api/admin/sql")
      .send({
        sql: "UPDATE app_settings SET value = '5' WHERE key = 'price_expiry_days'",
        allowWrite: true,
      });
    expect(response.status).toBe(200);
    expect(response.body.changes).toBe(1);
    expect(response.body.backup).toMatch(/^repair-inventory-\d{8}-\d{6}\.sqlite$/);

    // The write happened, and the pre-write backup captured the old value.
    const setting = ctx.harness.db
      .prepare("SELECT value FROM app_settings WHERE key = 'price_expiry_days'")
      .get() as { value: string };
    expect(setting.value).toBe("5");
    const backupFile = path.join(backupsDirOf(ctx.harness), response.body.backup as string);
    const snapshot = openDatabase(backupFile);
    try {
      const backedUp = snapshot
        .prepare("SELECT value FROM app_settings WHERE key = 'price_expiry_days'")
        .get() as { value: string };
      expect(backedUp.value).toBe("90");
    } finally {
      snapshot.close();
    }
  });

  it("a SELECT in write mode returns rows and does not need a backup", async () => {
    await ctx.admin
      .post("/api/admin/sql/write-mode")
      .send({ confirmation: WRITE_MODE_CONFIRMATION_PHRASE });
    const response = await ctx.admin
      .post("/api/admin/sql")
      .send({ sql: "SELECT COUNT(*) AS n FROM skus", allowWrite: true });
    expect(response.status).toBe(200);
    expect(response.body.rowCount).toBe(1);
    expect(response.body.backup).toBeUndefined();
  });

  it("the write toggle is per session and can be switched back off", async () => {
    await ctx.admin
      .post("/api/admin/sql/write-mode")
      .send({ confirmation: WRITE_MODE_CONFIRMATION_PHRASE });
    const off = await ctx.admin.delete("/api/admin/sql/write-mode");
    expect(off.body).toEqual({ writeMode: false });
    const refused = await ctx.admin
      .post("/api/admin/sql")
      .send({ sql: "DELETE FROM skus", allowWrite: true });
    expect(refused.status).toBe(403);
  });
});

describe("system info", () => {
  let ctx: HarnessHandle;
  let manager: ReturnType<typeof supertest.agent>;
  beforeAll(async () => {
    ctx = await withAdmin();
    manager = await managerAgentFor(ctx.harness);
  });
  afterAll(() => ctx.harness.close());

  it("reports row counts per table, applied migrations, uptime, and database file facts", async () => {
    await manager.post("/api/skus").send({ name: "Info SKU", price: "1.00", kind: "serialized" });
    const response = await ctx.admin.get("/api/admin/system");
    expect(response.status).toBe(200);

    const tables = response.body.tables as Array<{ name: string; rows: number }>;
    const byName = Object.fromEntries(tables.map((table) => [table.name, table.rows]));
    expect(byName.skus).toBe(1);
    expect(byName.users).toBe(1);
    expect(byName.app_settings).toBeGreaterThan(0);
    expect(tables.some((table) => table.name === "sqlite_sequence")).toBe(false);

    const migrations = response.body.migrations as Array<{ name: string; applied_at: string }>;
    expect(migrations).toHaveLength(MIGRATION_COUNT);
    expect(migrations[0].name).toBe("0001-migrations-table.sql");

    expect(response.body.uptimeSeconds).toBeGreaterThan(0);
    expect(response.body.dbPath).toBe(ctx.harness.dbPath);
    expect(response.body.dbSizeBytes).toBeGreaterThan(0);
    expect(response.body.backupsDirectory).toBe(backupsDirOf(ctx.harness));
    expect(typeof response.body.appVersion).toBe("string");
  });
});
