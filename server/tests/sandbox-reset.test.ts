import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import type { TestHarness } from "./harness.js";
import { createTestHarness, DEFAULT_MANAGER_EMAIL } from "./harness.js";
import { openDatabase } from "../db/connection.js";
import { knownMigrationNames, migrate } from "../db/migrate.js";
import { applyPendingRestore } from "../domains/admin/backups.js";
import { createApp } from "../app.js";
import { createLoggingEmailPlug } from "../domains/auth/email-plug.js";
import {
  PROD_STAGED_RESTORE,
  SANDBOX_ADMIN_COOKIE,
  SANDBOX_BACKUP_STEM,
  SANDBOX_MOUNT_PREFIX,
  SANDBOX_SESSION_COOKIE,
  SANDBOX_STAGED_RESTORE,
} from "../domain.js";

/**
 * Sandbox ticket 05 — resetting the sandbox from a backup. The trainer's
 * flow: prod panel → Backup → sandbox panel → Reset. These tests pin the
 * reset sources list (every .sqlite in the shared data/backups/, newest
 * first, sandbox snapshots labeled), the staging contract (validate BEFORE
 * anything is touched, auto-backup the current sandbox database first, stage
 * into the SANDBOX's OWN slot), the loud failures (missing/corrupt/wrong-
 * schema source), the REMOVAL of the sandbox's stock restore route (it would
 * have staged into the shared slot and been swapped into PRODUCTION at
 * startup — the ticket's live hazard), and the restart swap itself.
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

// Both instances' databases live in the same directory, so BOTH panels'
// backups — and BOTH staging slots' staged files — land in this one folder.
function backupsDirOf(harness: TestHarness): string {
  return path.join(path.dirname(harness.dbPath), "backups");
}

function listBackups(harness: TestHarness): string[] {
  const dir = backupsDirOf(harness);
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** The sandbox instance's own staging-slot marker (never the prod one). */
function sandboxMarkerPath(harness: TestHarness): string {
  return path.join(path.dirname(harness.sandbox.dbPath), SANDBOX_STAGED_RESTORE.markerStem + ".json");
}

/** The production instance's staging-slot marker. */
function prodMarkerPath(harness: TestHarness): string {
  return path.join(path.dirname(harness.dbPath), PROD_STAGED_RESTORE.markerStem + ".json");
}

async function withBothAdmins(): Promise<HarnessHandle> {
  const harness = createTestHarness({ adminKey: ADMIN_KEY });
  const admin = supertest.agent(harness.app);
  expect((await admin.post("/api/admin/session").send({ key: ADMIN_KEY })).status).toBe(204);
  const sandboxAdmin = supertest.agent(harness.app);
  expect(
    (await sandboxAdmin.post("/sandbox/api/admin/session").send({ key: ADMIN_KEY })).status
  ).toBe(204);
  return { harness, admin, sandboxAdmin };
}

/** Writes a file into data/backups/ with a PINNED mtime (deterministic ordering). */
function placeFile(dir: string, filename: string, sizeBytes: number, mtime: Date): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, filename);
  fs.writeFileSync(target, Buffer.alloc(sizeBytes, 7));
  fs.utimesSync(target, mtime, mtime);
}

describe("sandbox reset sources list", () => {
  let ctx: HarnessHandle;
  beforeEach(async () => {
    ctx = await withBothAdmins();
  });
  afterEach(() => ctx.harness.close());

  it("lists every .sqlite in data/backups/ newest first with size and mtime, labeling sandbox snapshots", async () => {
    const dir = backupsDirOf(ctx.harness);
    const jan1 = new Date("2026-01-01T10:00:00.000Z");
    const jan2 = new Date("2026-01-02T10:00:00.000Z");
    const jan3 = new Date("2026-01-03T10:00:00.000Z");
    placeFile(dir, "repair-inventory-20260101-000000.sqlite", 1_000, jan1);
    placeFile(dir, "sandbox-20260102-000000.sqlite", 2_000, jan2);
    placeFile(dir, "pre-restore-20260103-000000.sqlite", 3_000, jan3);
    // Not a .sqlite file — never offered as a reset source.
    placeFile(dir, "notes.txt", 10, jan3);

    const response = await ctx.sandboxAdmin.get("/sandbox/api/admin/reset/sources");
    expect(response.status).toBe(200);
    expect(response.body.empty).toBe(false);
    const sources = response.body.sources as Array<{
      filename: string;
      sizeBytes: number;
      modifiedAt: string;
      sandboxSnapshot: boolean;
    }>;
    expect(sources.map((source) => source.filename)).toEqual([
      "pre-restore-20260103-000000.sqlite",
      "sandbox-20260102-000000.sqlite",
      "repair-inventory-20260101-000000.sqlite",
    ]);
    expect(sources[0]).toMatchObject({ sizeBytes: 3_000, modifiedAt: jan3.toISOString(), sandboxSnapshot: false });
    expect(sources[1]).toMatchObject({ sizeBytes: 2_000, modifiedAt: jan2.toISOString(), sandboxSnapshot: true });
    expect(sources[2]).toMatchObject({ sizeBytes: 1_000, modifiedAt: jan1.toISOString(), sandboxSnapshot: false });
  });

  it("an empty (or absent) backups folder says so loudly", async () => {
    // No backup has ever been taken: the directory may not even exist yet.
    const response = await ctx.sandboxAdmin.get("/sandbox/api/admin/reset/sources");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sources: [], empty: true });
  });
});

describe("staging a sandbox reset", () => {
  let ctx: HarnessHandle;
  let sandboxManager: ReturnType<typeof supertest.agent>;
  let prodManager: ReturnType<typeof supertest.agent>;

  beforeEach(async () => {
    ctx = await withBothAdmins();
    sandboxManager = (await ctx.harness.loginAsOnSandbox(MANAGER)).agent;
    prodManager = (await ctx.harness.loginAs(MANAGER)).agent;
  });
  afterEach(() => ctx.harness.close());

  it("stages a picked backup into the sandbox's OWN slot — prod untouched byte-for-byte", async () => {
    // The state that goes INTO the source backup...
    await sandboxManager
      .post("/sandbox/api/skus")
      .send({ name: "Trainee Data", price: "1.00", kind: "serialized" });
    ctx.harness.clock.advance(1000);
    const backupResponse = await ctx.sandboxAdmin.get("/sandbox/api/admin/backup");
    expect(backupResponse.status).toBe(200);
    const sourceName = listBackups(ctx.harness).find((name) => name.startsWith("sandbox-"));
    expect(sourceName).toBeDefined();
    const sourceBytes = fs.readFileSync(path.join(backupsDirOf(ctx.harness), sourceName!));

    // ...and a write made AFTER the backup, which the swap must discard.
    await sandboxManager
      .post("/sandbox/api/skus")
      .send({ name: "Post-backup Trainee Data", price: "2.00", kind: "serialized" });

    // A prod anchor row, then a byte snapshot of the prod file: the reset
    // must not move production by a single byte.
    await prodManager
      .post("/api/skus")
      .send({ name: "Prod Anchor", price: "3.00", kind: "serialized" });
    const prodBytesBefore = fs.readFileSync(ctx.harness.dbPath);

    ctx.harness.clock.advance(1000);
    const response = await ctx.sandboxAdmin
      .post("/sandbox/api/admin/reset")
      .send({ filename: sourceName });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, restartRequired: true });
    // The auto-backup of the CURRENT sandbox database, taken first, is the
    // undo path — and it carries the sandbox stem.
    expect(response.body.backup).toMatch(/^sandbox-\d{8}-\d{6}\.sqlite$/);
    // The staged file carries the sandbox's OWN marker stem.
    expect(response.body.staged).toMatch(/^pending-restore-sandbox-\d{8}-\d{6}\.sqlite$/);
    expect(listBackups(ctx.harness)).toContain(response.body.staged);

    // The picked source survives UNCHANGED in data/backups/ (copied, never moved).
    expect(fs.readFileSync(path.join(backupsDirOf(ctx.harness), sourceName!)).equals(sourceBytes)).toBe(
      true
    );

    // The marker is the sandbox's OWN slot's — the production marker name
    // stays untouched. THIS is the ticket-05 hazard regression: before the
    // per-instance slots, a staged sandbox reset wrote the PROD marker name.
    const marker = JSON.parse(fs.readFileSync(sandboxMarkerPath(ctx.harness), "utf8")) as {
      file: string;
      requestedAt: string;
      backup: string;
    };
    expect(marker).toMatchObject({ file: response.body.staged, backup: response.body.backup });
    expect(fs.existsSync(prodMarkerPath(ctx.harness))).toBe(false);
    // And the production startup swap sees no pending restore of its own.
    expect(await applyPendingRestore(ctx.harness.dbPath, PROD_STAGED_RESTORE)).toBeUndefined();

    // Nothing has swapped yet: the live sandbox keeps the post-backup row.
    const names = (
      ctx.harness.sandbox.db.prepare("SELECT name FROM skus ORDER BY name").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(names).toContain("Post-backup Trainee Data");

    // Production is untouched byte-for-byte.
    expect(fs.readFileSync(ctx.harness.dbPath).equals(prodBytesBefore)).toBe(true);
  });

  it("stages an uploaded file identically, leaving no temp debris", async () => {
    // A valid database file built on the real migrations (the upload path
    // runs the same validation as prod Restore).
    const uploadPath = path.join(path.dirname(ctx.harness.dbPath), "upload-source.sqlite");
    const source = openDatabase(uploadPath);
    migrate(source, ctx.harness.clock);
    source.close();

    ctx.harness.clock.advance(1000);
    const response = await ctx.sandboxAdmin
      .post("/sandbox/api/admin/reset")
      .query({ filename: "upload-source.sqlite" })
      .set("content-type", "application/octet-stream")
      .send(fs.readFileSync(uploadPath));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, restartRequired: true });
    expect(response.body.backup).toMatch(/^sandbox-\d{8}-\d{6}\.sqlite$/);
    expect(response.body.staged).toMatch(/^pending-restore-sandbox-\d{8}-\d{6}\.sqlite$/);
    expect(listBackups(ctx.harness)).toContain(response.body.staged);
    // The upload's staging candidate was renamed into place, and its
    // validation sidecars were cleaned up: the only staging-slot file left
    // is the staged one itself.
    expect(
      listBackups(ctx.harness).filter((name) => name.startsWith("pending-restore-sandbox-"))
    ).toEqual([response.body.staged]);
    // ...and the marker is in the sandbox's own slot.
    expect(fs.existsSync(sandboxMarkerPath(ctx.harness))).toBe(true);
    expect(fs.existsSync(prodMarkerPath(ctx.harness))).toBe(false);
  });

  it("a missing picked file fails loudly with nothing touched", async () => {
    const before = listBackups(ctx.harness);
    const response = await ctx.sandboxAdmin
      .post("/sandbox/api/admin/reset")
      .send({ filename: "no-such-backup.sqlite" });
    expect(response.status).toBe(404);
    expect(response.body.error).toContain("no backup named no-such-backup.sqlite");
    // No auto-backup, no staging, no marker: the refusal happened BEFORE
    // anything was touched.
    expect(listBackups(ctx.harness)).toEqual(before);
    expect(fs.existsSync(sandboxMarkerPath(ctx.harness))).toBe(false);
  });

  it("a corrupt or wrong-schema source is refused before anything is staged", async () => {
    const dir = backupsDirOf(ctx.harness);
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(dir, "corrupt.sqlite"), Buffer.from("this is not a database"));

    // A database whose migration history is not a prefix of this server's.
    const future = path.join(dir, "future.sqlite");
    const futureDb = new Database(future);
    futureDb.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    futureDb
      .prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)")
      .run("0001-migrations-table.sql", "2026-01-01T00:00:00.000Z");
    futureDb
      .prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)")
      .run("9999-from-the-future.sql", "2026-01-02T00:00:00.000Z");
    futureDb.close();

    // The fixture files are the baseline: every refusal must add NOTHING.
    const before = listBackups(ctx.harness);

    const corrupt = await ctx.sandboxAdmin
      .post("/sandbox/api/admin/reset")
      .send({ filename: "corrupt.sqlite" });
    expect(corrupt.status).toBe(400);
    expect(corrupt.body.error).toContain("could not inspect the uploaded file");
    const wrongSchema = await ctx.sandboxAdmin
      .post("/sandbox/api/admin/reset")
      .send({ filename: "future.sqlite" });
    expect(wrongSchema.status).toBe(400);
    expect(wrongSchema.body.error).toContain("migration state mismatch at position 2");

    // Path traversal in a picked filename is a 400, never a read outside
    // data/backups/.
    const traversal = await ctx.sandboxAdmin
      .post("/sandbox/api/admin/reset")
      .send({ filename: "../repair-inventory.sqlite" });
    expect(traversal.status).toBe(400);
    expect(traversal.body.error).toContain("not a backup filename");

    // Every refusal happened BEFORE the auto-backup: nothing new on disk.
    expect(listBackups(ctx.harness)).toEqual(before);
    expect(fs.existsSync(sandboxMarkerPath(ctx.harness))).toBe(false);

    // The sandbox is intact and still serving on its current data.
    const probe = await sandboxManager.get("/sandbox/api/auth/me");
    expect(probe.status).toBe(200);
  });

  it("the sandbox's stock restore route is GONE — superseded by reset; prod's remains", async () => {
    // A second staging route on the sandbox would double-mean one URL and,
    // worse, used to stage into the shared slot that startup applied to the
    // PRODUCTION file. It answers 404 — indistinguishable from nonexistent.
    const sandboxRestore = await ctx.sandboxAdmin
      .post("/sandbox/api/admin/restore")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("anything"));
    expect(sandboxRestore.status).toBe(404);

    // Production's own restore route still exists (wrong body → its 400).
    const prodRestore = await ctx.admin
      .post("/api/admin/restore")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("anything"));
    expect(prodRestore.status).toBe(400);
  });

  it("reset demands the admin key session, like every admin route", async () => {
    expect(
      (await ctx.harness.request.get("/sandbox/api/admin/reset/sources")).status
    ).toBe(401);
    expect(
      (
        await ctx.harness.request.post("/sandbox/api/admin/reset").send({ filename: "x.sqlite" })
      ).status
    ).toBe(401);
  });
});

describe("sandbox reset with ADMIN_KEY unset", () => {
  it("answers 404 — the disabled surface reveals nothing", async () => {
    const harness = createTestHarness();
    try {
      const response = await harness.request.get("/sandbox/api/admin/reset/sources");
      expect(response.status).toBe(404);
    } finally {
      harness.close();
    }
  });
});

describe("sandbox reset swap at startup (applyPendingRestore)", () => {
  // This block manages its own lifecycle: the swap replaces the sandbox
  // database file under the process, so the harness's sandbox handle must be
  // closed by hand.
  let harness: TestHarness;
  let sandboxAdmin: ReturnType<typeof supertest.agent>;
  let sourceName: string;
  /** The trainee's sandbox session cookie, captured before the reset. */
  let traineeCookie: string;

  beforeAll(async () => {
    harness = createTestHarness({ adminKey: ADMIN_KEY });
    sandboxAdmin = supertest.agent(harness.app);
    expect(
      (await sandboxAdmin.post("/sandbox/api/admin/session").send({ key: ADMIN_KEY })).status
    ).toBe(204);

    // The reset SOURCE: the pristine sandbox (the seeded manager only, no
    // sessions, no trainee user) — snapshotted through the real backup route.
    const backupResponse = await sandboxAdmin.get("/sandbox/api/admin/backup");
    expect(backupResponse.status).toBe(200);
    sourceName = listBackups(harness).find((name) => name.startsWith("sandbox-"))!;

    // A trainee user created AFTER the snapshot — must vanish with the reset.
    const created = await sandboxAdmin
      .post("/sandbox/api/admin/users")
      .send({ email: "trainee@acme.co", role: "tech" });
    expect(created.status).toBe(201);

    // The trainee logs in through the real sandbox flow; the session row is
    // written AFTER the snapshot too.
    const requestLink = await harness.request
      .post("/sandbox/api/auth/request-link")
      .send({ email: "trainee@acme.co" });
    expect(requestLink.status).toBe(202);
    const link = [...harness.sandbox.emails.sent]
      .reverse()
      .find((sent) => sent.to === "trainee@acme.co");
    expect(link).toBeDefined();
    const token = new URL(link!.url).searchParams.get("token");
    expect(token).toBeDefined();
    const redeem = await harness.request.post("/sandbox/api/auth/redeem").send({ token });
    expect(redeem.status).toBe(200);
    traineeCookie = redeem.headers["set-cookie"][0];

    // A trainee-created SKU — post-backup data the swap must discard.
    const sku = await supertest(harness.app)
      .post("/sandbox/api/skus")
      .set("cookie", traineeCookie)
      .send({ name: "Trainee SKU", price: "1.00", kind: "serialized" });
    expect(sku.status).toBe(201);
  });

  afterAll(() => {
    try {
      harness.db.close();
    } catch {
      // already closed
    }
    try {
      harness.sandbox.db.close();
    } catch {
      // already closed by the swap
    }
    fs.rmSync(path.dirname(harness.dbPath), { recursive: true, force: true });
  });

  it("replaces the sandbox database at the next start — the prod file is never touched", async () => {
    // The prod anchor: a row that exists ONLY in production, written after
    // the sandbox snapshot was taken.
    const manager = await harness.loginAs(MANAGER);
    await manager.agent.post("/api/skus").send({ name: "Prod Anchor", price: "9.00", kind: "serialized" });
    const prodBytesBefore = fs.readFileSync(harness.dbPath);

    harness.clock.advance(1000);
    const response = await sandboxAdmin.post("/sandbox/api/admin/reset").send({ filename: sourceName });
    expect(response.status).toBe(200);

    // Simulate the restart: close the live sandbox handle, run the sandbox
    // instance's startup swap (its own seam, its own slot).
    harness.sandbox.db.close();
    const marker = await applyPendingRestore(harness.sandbox.dbPath, SANDBOX_STAGED_RESTORE);
    expect(marker).toMatchObject({ file: response.body.staged, backup: response.body.backup });

    // The sandbox now serves the snapshot's data: the trainee SKU is gone.
    const restored = openDatabase(harness.sandbox.dbPath);
    try {
      expect(
        (restored.prepare("SELECT COUNT(*) AS n FROM skus").get() as { n: number }).n
      ).toBe(0);
      // Trainee-created users vanished; the seeded manager remains.
      const emails = (
        restored.prepare("SELECT email FROM users ORDER BY id").all() as Array<{ email: string }>
      ).map((row) => row.email);
      expect(emails).toEqual([MANAGER]);
      // Sessions came from the backup: none.
      expect((restored.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n).toBe(
        0
      );
      // The startup migration run finished the restored schema.
      expect(
        (restored.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n
      ).toBe(MIGRATION_COUNT);
    } finally {
      restored.close();
    }

    // Danger rule: the replaced state was backed up first, under the
    // sandbox's own pre-swap stem.
    expect(
      listBackups(harness).some((name) => name.startsWith("pre-restore-sandbox-"))
    ).toBe(true);
    // The marker is consumed.
    expect(fs.existsSync(sandboxMarkerPath(harness))).toBe(false);
    // A second run with no marker pending is a no-op.
    expect(await applyPendingRestore(harness.sandbox.dbPath, SANDBOX_STAGED_RESTORE)).toBeUndefined();

    // Production: byte-for-byte untouched — the sandbox swap never read or
    // wrote the prod file, and the prod marker was never involved.
    expect(fs.readFileSync(harness.dbPath).equals(prodBytesBefore)).toBe(true);
    expect(fs.existsSync(prodMarkerPath(harness))).toBe(false);
    expect(await applyPendingRestore(harness.dbPath, PROD_STAGED_RESTORE)).toBeUndefined();
  });

  it("a sandbox session cookie held across reset+restart no longer authenticates", async () => {
    // A fresh app wired to the restored sandbox file — the state a restarted
    // server would serve. The trainee's pre-reset cookie must be dead: the
    // sessions table came from the backup.
    const restoredDb = openDatabase(harness.sandbox.dbPath);
    migrate(restoredDb, harness.clock);
    const app = createApp({
      db: restoredDb,
      clock: harness.clock,
      dbPath: harness.sandbox.dbPath,
      sessionCookie: SANDBOX_SESSION_COOKIE,
      adminCookie: SANDBOX_ADMIN_COOKIE,
      mountPrefix: SANDBOX_MOUNT_PREFIX,
      backupStem: SANDBOX_BACKUP_STEM,
      stagedRestore: SANDBOX_STAGED_RESTORE,
      emailPlug: createLoggingEmailPlug(),
    });
    try {
      const me = await supertest(app).get("/api/auth/me").set("cookie", traineeCookie);
      expect(me.status).toBe(401);
    } finally {
      restoredDb.close();
    }
  });
});
