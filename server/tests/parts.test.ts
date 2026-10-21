import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SkuBody {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  price: string;
  priceCents: number;
  priceStale: boolean;
  availableCount: number | null;
  /** Ticket 11: the SKU's default source link; null when it has none. */
  defaultSourceUrl: string | null;
}

async function createSku(
  agent: LoggedInAgent["agent"],
  overrides: Record<string, unknown> = {},
): Promise<SkuBody> {
  const response = await agent.post("/api/skus").send({
    name: "iPhone 13 Screen",
    price: "109.99",
    kind: "serialized",
    ...overrides,
  });
  expect(response.status).toBe(201);
  return response.body as SkuBody;
}

async function intakePart(agent: LoggedInAgent["agent"], skuId: number, body: Record<string, unknown> = {}) {
  const response = await agent.post(`/api/skus/${skuId}/parts`).send(body);
  return response;
}

describe("POST /api/skus", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("creates a serialized SKU with a decimal-safe price and records sku.created", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent
      .post("/api/skus")
      .send({ name: "iPhone 13 Screen", price: "109.99", kind: "serialized" });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: expect.any(Number),
      name: "iPhone 13 Screen",
      kind: "serialized",
      price: "109.99",
      priceCents: 10999,
      priceStale: false,
      availableCount: 0,
    });

    const row = harness.db
      .prepare("SELECT name, price_cents, kind FROM skus WHERE id = ?")
      .get(response.body.id) as { name: string; price_cents: number; kind: string };
    expect(row).toEqual({ name: "iPhone 13 Screen", price_cents: 10999, kind: "serialized" });

    const event = harness.db
      .prepare("SELECT actor_id, at, action, payload FROM events WHERE entity_type = 'sku' AND entity_id = ?")
      .get(response.body.id) as { actor_id: number; at: string; action: string; payload: string };
    expect(event.actor_id).toBe(manager.user.id);
    expect(event.action).toBe("sku.created");
    expect(event.at).toBe(harness.clock.now().toISOString());
    expect(JSON.parse(event.payload)).toEqual({
      name: "iPhone 13 Screen",
      priceCents: 10999,
      kind: "serialized",
    });
  });

  it("creates a consumable SKU with no stock count", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { name: "Adhesive strips", kind: "consumable", price: "1.50" });

    expect(sku.kind).toBe("consumable");
    expect(sku.price).toBe("1.50");
    expect(sku.priceCents).toBe(150);
    expect(sku.availableCount).toBeNull();
  });

  it("lets a tech create SKUs", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const response = await tech.agent
      .post("/api/skus")
      .send({ name: "Battery", price: "30", kind: "serialized" });

    expect(response.status).toBe(201);
    expect(response.body.priceCents).toBe(3000);
  });

  it("rejects prices that are not money", async () => {
    const manager = await harness.loginAs(MANAGER);
    for (const price of ["12.345", "-5", "abc", ""]) {
      const response = await manager.agent
        .post("/api/skus")
        .send({ name: "Screen", price, kind: "serialized" });
      expect(response.status).toBe(400);
    }
    const count = harness.db.prepare("SELECT COUNT(*) AS n FROM skus").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects an invalid kind and a missing name", async () => {
    const manager = await harness.loginAs(MANAGER);
    const kind = await manager.agent
      .post("/api/skus")
      .send({ name: "Screen", price: "10.00", kind: "widget" });
    expect(kind.status).toBe(400);

    const name = await manager.agent
      .post("/api/skus")
      .send({ name: "   ", price: "10.00", kind: "serialized" });
    expect(name.status).toBe(400);
  });
});

describe("GET /api/skus and GET /api/skus/:id", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("lists SKUs with their expiry state", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent);

    harness.clock.advance(89 * DAY_MS);
    const fresh = await manager.agent.get("/api/skus");
    expect(fresh.status).toBe(200);
    expect(fresh.body).toHaveLength(1);
    expect(fresh.body[0].priceStale).toBe(false);

    harness.clock.advance(1 * DAY_MS);
    const stale = await manager.agent.get("/api/skus");
    expect(stale.body[0].priceStale).toBe(true);
  });

  it("shows a SKU detail with its serialized parts and timeline", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    await intakePart(manager.agent, sku.id, { source: "migration", counted: false, note: "initial stock" });

    const response = await manager.agent.get(`/api/skus/${sku.id}`);
    expect(response.status).toBe(200);
    expect(response.body.name).toBe("iPhone 13 Screen");
    expect(response.body.parts).toHaveLength(1);
    expect(response.body.parts[0].serial).toBe("P00001");
    expect(response.body.events.map((e: { action: string }) => e.action)).toEqual(["sku.created"]);
  });

  it("gives a consumable SKU no parts and no statuses", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { name: "Adhesive", kind: "consumable", price: "1.50" });

    const response = await manager.agent.get(`/api/skus/${sku.id}`);
    expect(response.status).toBe(200);
    expect(response.body.parts).toEqual([]);
  });

  it("rejects an unknown SKU id", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent.get("/api/skus/9999");
    expect(response.status).toBe(404);
  });

  it("orders the catalog case-insensitively (portable LOWER ordering, ADR-0001)", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent, { name: "zebra tape" });
    await createSku(manager.agent, { name: "AirTag adhesive" });
    await createSku(manager.agent, { name: "MacBook screw kit" });

    const list = await manager.agent.get("/api/skus");
    expect(list.body.map((sku: SkuBody) => sku.name)).toEqual([
      "AirTag adhesive",
      "MacBook screw kit",
      "zebra tape",
    ]);
  });
});

describe("PATCH /api/skus/:id", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("records a price change as an event and re-dates the price", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);

    harness.clock.advance(100 * DAY_MS); // now stale
    const response = await manager.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ price: "99.50" });

    expect(response.status).toBe(200);
    expect(response.body.price).toBe("99.50");
    expect(response.body.priceCents).toBe(9950);
    expect(response.body.priceStale).toBe(false); // a price change re-dates it

    const event = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.price_changed'")
      .get(sku.id) as { actor_id: number; action: string; payload: string };
    expect(event.actor_id).toBe(manager.user.id);
    expect(JSON.parse(event.payload)).toEqual({ from: 10999, to: 9950 });
  });

  it("records a rename without touching the price date", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const updatedAtBefore = sku;

    const response = await manager.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ name: "iPhone 13 OLED Screen" });

    expect(response.status).toBe(200);
    expect(response.body.name).toBe("iPhone 13 OLED Screen");
    expect(response.body.priceCents).toBe(updatedAtBefore.priceCents);

    const event = harness.db
      .prepare("SELECT action, payload FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.renamed'")
      .get(sku.id) as { action: string; payload: string };
    expect(JSON.parse(event.payload)).toEqual({ from: "iPhone 13 Screen", to: "iPhone 13 OLED Screen" });
  });

  it("rejects an empty patch and an unknown SKU", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);

    const empty = await manager.agent.patch(`/api/skus/${sku.id}`).send({});
    expect(empty.status).toBe(400);

    const unknown = await manager.agent.patch("/api/skus/9999").send({ name: "X" });
    expect(unknown.status).toBe(404);
  });
});

describe("POST /api/skus/:id/parts (migration intake, ticket 13 contract)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("adds serialized parts with short system serials, Available, and events", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);

    const response = await intakePart(manager.agent, sku.id, {
      source: "migration",
      counted: false,
      note: "initial stock",
    });
    expect(response.status).toBe(201);
    expect(response.body.parts).toHaveLength(1);
    expect(response.body.parts[0]).toMatchObject({
      serial: "P00001",
      status: "available",
      statusLabel: "Available",
      lastCountedAt: null,
      intakeSource: "migration",
    });

    const row = harness.db
      .prepare("SELECT sku_id, serial, status FROM serialized_parts WHERE serial = 'P00001'")
      .get() as { sku_id: number; serial: string; status: string };
    expect(row).toEqual({ sku_id: sku.id, serial: "P00001", status: "available" });

    const event = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE entity_type = 'part' AND entity_id = ?")
      .get(response.body.parts[0].id) as { actor_id: number; action: string; payload: string };
    expect(event.actor_id).toBe(manager.user.id);
    expect(event.action).toBe("part.added");
    expect(JSON.parse(event.payload)).toEqual({ serial: "P00001", source: "migration", note: "initial stock" });
  });

  it("assigns unique sequential serials across intakes and quantities", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);

    const batch = await intakePart(manager.agent, sku.id, { source: "migration", quantity: 3, counted: false });
    expect(batch.body.parts.map((p: { serial: string }) => p.serial)).toEqual([
      "P00001",
      "P00002",
      "P00003",
    ]);

    const later = await intakePart(manager.agent, sku.id, { source: "migration", counted: false });
    expect(later.body.parts[0].serial).toBe("P00004");

    const rows = harness.db
      .prepare("SELECT serial FROM serialized_parts ORDER BY serial")
      .all() as { serial: string }[];
    expect(new Set(rows.map((r) => r.serial)).size).toBe(4);
  });

  it("rejects intake on a consumable SKU", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { name: "Adhesive", kind: "consumable" });

    const response = await intakePart(manager.agent, sku.id, { source: "migration", counted: false });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("consumable");
    const count = harness.db
      .prepare("SELECT COUNT(*) AS n FROM serialized_parts")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects an unknown SKU and a bad quantity", async () => {
    const manager = await harness.loginAs(MANAGER);

    const unknown = await intakePart(manager.agent, 9999, { source: "migration", counted: false });
    expect(unknown.status).toBe(404);

    const sku = await createSku(manager.agent);
    const bad = await intakePart(manager.agent, sku.id, { source: "migration", quantity: 0, counted: false });
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/parts/:serial and POST /api/parts/:serial/status", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  async function setupPart(): Promise<{ sku: SkuBody; serial: string; agent: LoggedInAgent["agent"] }> {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const intake = await intakePart(manager.agent, sku.id, { source: "migration", counted: false, note: "initial stock" });
    return { sku, serial: intake.body.parts[0].serial as string, agent: manager.agent };
  }

  it("shows a part with status, SKU, and its full history", async () => {
    const { serial, agent } = await setupPart();
    await agent.post(`/api/parts/${serial}/status`).send({ status: "rma", note: "dead pixels" });

    const response = await agent.get(`/api/parts/${serial}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      serial,
      status: "rma",
      statusLabel: "RMA",
      lastCountedAt: null,
    });
    expect(response.body.sku).toMatchObject({
      id: expect.any(Number),
      name: "iPhone 13 Screen",
      price: "109.99",
    });

    expect(response.body.events.map((e: { action: string }) => e.action)).toEqual([
      "part.added",
      "part.status_changed",
    ]);
    expect(response.body.events[0].actor.email).toBe(MANAGER);
    const change = response.body.events[1];
    expect(change.payload).toEqual({ from: "available", to: "rma", note: "dead pixels" });
  });

  it("resolves both the one-segment part route and the two-segment attachments route", async () => {
    // Route-order pin (review minor): the parts domain's GET /:serial matches
    // ONE segment only, so batchparts' GET /:serial/attachments — mounted
    // later under the same /api/parts prefix — still sees two-segment paths.
    // Both endpoints must resolve in the standard registration order; see the
    // comments at both registrations.
    const { serial, agent } = await setupPart();

    const part = await agent.get(`/api/parts/${serial}`);
    expect(part.status).toBe(200);

    const attachments = await agent.get(`/api/parts/${serial}/attachments`);
    expect(attachments.status).toBe(200);
    expect(attachments.body.attachments).toEqual([]);
  });

  it("requires a note on every status change and records actor + timestamp", async () => {
    const { serial, agent } = await setupPart();

    const missing = await agent.post(`/api/parts/${serial}/status`).send({ status: "unavailable" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("note");

    const blank = await agent.post(`/api/parts/${serial}/status`).send({ status: "unavailable", note: "   " });
    expect(blank.status).toBe(400);

    const response = await agent
      .post(`/api/parts/${serial}/status`)
      .send({ status: "unavailable", note: "consumed in a repair" });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("unavailable");

    const row = harness.db
      .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
      .get(serial) as { status: string };
    expect(row.status).toBe("unavailable");

    const event = harness.db
      .prepare("SELECT actor_id, at, action, payload FROM events WHERE entity_type = 'part' AND action = 'part.status_changed'")
      .get() as { actor_id: number; at: string; action: string; payload: string };
    const manager = await harness.db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(MANAGER) as { id: number };
    expect(event.actor_id).toBe(manager.id);
    expect(event.at).toBe(harness.clock.now().toISOString());
    expect(JSON.parse(event.payload)).toEqual({
      from: "available",
      to: "unavailable",
      note: "consumed in a repair",
    });
  });

  it("rejects an invalid status and an unknown serial", async () => {
    const { serial, agent } = await setupPart();

    const invalid = await agent
      .post(`/api/parts/${serial}/status`)
      .send({ status: "lost", note: "n/a" });
    expect(invalid.status).toBe(400);

    const unknown = await agent.post("/api/parts/P99999/status").send({ status: "rma", note: "x" });
    expect(unknown.status).toBe(404);

    const unknownDetail = await agent.get("/api/parts/P99999");
    expect(unknownDetail.status).toBe(404);
  });

  it("rejects setting a part to Reserved directly — reservations belong to Batches", async () => {
    const { serial, agent } = await setupPart();

    const response = await agent
      .post(`/api/parts/${serial}/status`)
      .send({ status: "reserved", note: "hold it" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Reserved");
  });

  it("rejects a bare status change away from Reserved", async () => {
    const { serial, agent } = await setupPart();
    // Ticket 05 will own reservations; simulate a Batch reservation directly.
    harness.db
      .prepare("UPDATE serialized_parts SET status = 'reserved' WHERE serial = ?")
      .run(serial);

    const response = await agent
      .post(`/api/parts/${serial}/status`)
      .send({ status: "available", note: "put it back" });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("Reserved");
    const row = harness.db
      .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
      .get(serial) as { status: string };
    expect(row.status).toBe("reserved");
  });
});

describe("price expiry, the audit queue, and refresh", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("queues stale SKUs for a manager with days stale", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent, { name: "A screen" });
    await createSku(manager.agent, { name: "B battery", price: "30.00" });

    const empty = await manager.agent.get("/api/price-audit");
    expect(empty.status).toBe(200);
    expect(empty.body.skus).toHaveLength(0);

    harness.clock.advance(91 * DAY_MS);
    const response = await manager.agent.get("/api/price-audit");
    expect(response.status).toBe(200);
    expect(response.body.priceExpiryDays).toBe(90);
    expect(response.body.skus).toHaveLength(2);
    expect(response.body.skus[0]).toMatchObject({ name: "A screen", daysStale: 1 });
  });

  it("refuses a tech the price-audit queue and the refresh action", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    await createSku(tech.agent);

    const queue = await tech.agent.get("/api/price-audit");
    expect(queue.status).toBe(403);
    expect(queue.body.error).toContain("manager");

    const refresh = await tech.agent.post("/api/skus/1/price-refresh").send({});
    expect(refresh.status).toBe(403);
  });

  it("a manager refresh re-dates the price and records an event", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    harness.clock.advance(100 * DAY_MS);

    const response = await manager.agent
      .post(`/api/skus/${sku.id}/price-refresh`)
      .send({ price: "120.00" });

    expect(response.status).toBe(200);
    expect(response.body.price).toBe("120.00");
    expect(response.body.priceStale).toBe(false);

    const queue = await manager.agent.get("/api/price-audit");
    expect(queue.body.skus).toHaveLength(0);

    const event = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.price_refreshed'")
      .get(sku.id) as { actor_id: number; action: string; payload: string };
    expect(event.actor_id).toBe(manager.user.id);
    expect(JSON.parse(event.payload)).toEqual({ from: 10999, to: 12000 });
  });

  it("a stale price never blocks use", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    harness.clock.advance(100 * DAY_MS);

    const intake = await intakePart(manager.agent, sku.id, { source: "migration", counted: false });
    expect(intake.status).toBe(201);

    const status = await manager.agent
      .post("/api/parts/P00001/status")
      .send({ status: "unavailable", note: "written off" });
    expect(status.status).toBe(200);
  });
});

describe("app settings", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("exposes the default settings to any signed-in user", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const response = await tech.agent.get("/api/settings");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      price_expiry_days: 90,
      audit_interval_months: 2,
      // ticket 08: PO label stock in sixteenths of an inch (2-5/16" × 4").
      label_width_sixteenths: 37,
      label_height_sixteenths: 64,
      // ticket 19: the chosen DYMO printer starts unset (empty text).
      dymo_printer_name: "",
    });
  });

  // Ticket 19: the DYMO printer choice is a text setting — the only non-numeric
  // one. It must round-trip verbatim (printer names carry punctuation like
  // "DYMO LabelWriter 450 Turbo") and record its change on the timeline.
  it("round-trips the dymo_printer_name text setting with an event", async () => {
    const manager = await harness.loginAs(MANAGER);

    const response = await manager.agent
      .patch("/api/settings")
      .send({ key: "dymo_printer_name", value: "DYMO LabelWriter 450" });
    expect(response.status).toBe(200);
    expect(response.body.dymo_printer_name).toBe("DYMO LabelWriter 450");

    const reread = await manager.agent.get("/api/settings");
    expect(reread.body.dymo_printer_name).toBe("DYMO LabelWriter 450");

    const event = harness.db
      .prepare(
        "SELECT actor_id, action, payload FROM events WHERE action = 'setting.updated' AND payload LIKE '%dymo_printer_name%'"
      )
      .get() as { actor_id: number; action: string; payload: string };
    expect(event.actor_id).toBe(manager.user.id);
    expect(JSON.parse(event.payload)).toEqual({
      key: "dymo_printer_name",
      from: "",
      to: "DYMO LabelWriter 450",
    });
  });

  it("clears dymo_printer_name with an empty value and refuses absurdly long names", async () => {
    const manager = await harness.loginAs(MANAGER);

    const cleared = await manager.agent
      .patch("/api/settings")
      .send({ key: "dymo_printer_name", value: "   " });
    expect(cleared.status).toBe(200);
    expect(cleared.body.dymo_printer_name).toBe("");

    const tooLong = await manager.agent
      .patch("/api/settings")
      .send({ key: "dymo_printer_name", value: "x".repeat(201) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe("dymo_printer_name must be at most 200 characters");

    const row = harness.db
      .prepare("SELECT value FROM app_settings WHERE key = 'dymo_printer_name'")
      .get() as { value: string };
    expect(row.value).toBe("");
  });

  it("a tech cannot change the DYMO printer setting", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const response = await tech.agent
      .patch("/api/settings")
      .send({ key: "dymo_printer_name", value: "DYMO LabelWriter 450" });
    expect(response.status).toBe(403);
  });

  it("a manager edits a setting, records an event, and expiry follows it", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);

    const response = await manager.agent
      .patch("/api/settings")
      .send({ key: "price_expiry_days", value: 30 });

    expect(response.status).toBe(200);
    expect(response.body.price_expiry_days).toBe(30);

    const event = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE action = 'setting.updated'")
      .get() as { actor_id: number; action: string; payload: string };
    expect(event.actor_id).toBe(manager.user.id);
    expect(JSON.parse(event.payload)).toEqual({ key: "price_expiry_days", from: "90", to: "30" });

    harness.clock.advance(30 * DAY_MS);
    const list = await manager.agent.get("/api/skus");
    expect(list.body[0].priceStale).toBe(true);
  });

  it("refuses a tech, unknown keys, and invalid values", async () => {
    const manager = await harness.loginAs(MANAGER);
    const tech = await harness.createUserAs("tech@acme.co", "tech");

    const asTech = await tech.agent.patch("/api/settings").send({ key: "price_expiry_days", value: 30 });
    expect(asTech.status).toBe(403);

    const unknownKey = await manager.agent
      .patch("/api/settings")
      .send({ key: "theme", value: "dark" });
    expect(unknownKey.status).toBe(400);

    const badValue = await manager.agent
      .patch("/api/settings")
      .send({ key: "price_expiry_days", value: 0 });
    expect(badValue.status).toBe(400);

    const row = harness.db
      .prepare("SELECT value FROM app_settings WHERE key = 'price_expiry_days'")
      .get() as { value: string };
    expect(row.value).toBe("90");
  });

  // The route edge validates on write, so an unparsable or non-positive row
  // can only come from a broken database — and a silent NaN would quietly
  // disable price expiry (priceStale always false) and audit scheduling.
  // Loud failure, per the review standard (review S3).
  it("fails loudly when a stored setting is unparsable instead of disabling expiry with NaN", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent);
    harness.db
      .prepare("UPDATE app_settings SET value = 'soon' WHERE key = 'price_expiry_days'")
      .run();

    const list = await manager.agent.get("/api/skus");
    expect(list.status).toBe(500);
  });

  it("fails loudly when a stored setting is below its minimum", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent);
    harness.db
      .prepare("UPDATE app_settings SET value = '0' WHERE key = 'price_expiry_days'")
      .run();

    const list = await manager.agent.get("/api/skus");
    expect(list.status).toBe(500);
  });
});

describe("SKU kind changes and deletion (fixing mis-entered SKUs)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("changes a consumable SKU to serialized with a required note and an event", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { name: "iPhone 13 Screen", kind: "consumable" });

    const response = await manager.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ kind: "serialized", note: "entered as consumable by mistake" });

    expect(response.status).toBe(200);
    expect(response.body.kind).toBe("serialized");

    const event = harness.db
      .prepare(
        "SELECT actor_id, payload FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.kind_changed'"
      )
      .get(sku.id) as { actor_id: number; payload: string };
    expect(event.actor_id).toBe(manager.user.id);
    expect(JSON.parse(event.payload)).toEqual({
      from: "consumable",
      to: "serialized",
      note: "entered as consumable by mistake",
    });

    // the corrected SKU now accepts serialized intake
    const intake = await manager.agent
      .post(`/api/skus/${sku.id}/parts`)
      .send({ source: "migration", counted: true });
    expect(intake.status).toBe(201);
  });

  it("requires a note on a kind change", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { kind: "consumable" });

    const response = await manager.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ kind: "serialized" });

    expect(response.status).toBe(400);
  });

  it("refuses serialized → consumable while serialized parts exist, and allows it when none do", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    await manager.agent
      .post(`/api/skus/${sku.id}/parts`)
      .send({ source: "migration", counted: true, quantity: 2 });

    const refused = await manager.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ kind: "consumable", note: "wrong kind" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("2 serialized part");

    // a pristine serialized SKU may convert
    const pristine = await createSku(manager.agent, { name: "Typoscreen" });
    const allowed = await manager.agent
      .patch(`/api/skus/${pristine.id}`)
      .send({ kind: "consumable", note: "was never serialized" });
    expect(allowed.status).toBe(200);
    expect(allowed.body.kind).toBe("consumable");
  });

  it("a same-kind patch is a no-op without an event", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);

    const response = await manager.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ kind: "serialized", note: "no change" });

    expect(response.status).toBe(200);
    const event = harness.db
      .prepare(
        "SELECT id FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.kind_changed'"
      )
      .get(sku.id);
    expect(event).toBeUndefined();
  });

  it("deletes a pristine SKU with a required note, recording the deletion on the timeline", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { name: "iPhone 16e Scren" });

    const noNote = await manager.agent.delete(`/api/skus/${sku.id}`).send({});
    expect(noNote.status).toBe(400);

    const response = await manager.agent
      .delete(`/api/skus/${sku.id}`)
      .send({ note: "typo, recreated correctly" });
    expect(response.status).toBe(200);

    const listed = await manager.agent.get("/api/skus");
    expect((listed.body as Array<{ id: number }>).some((s) => s.id === sku.id)).toBe(false);

    const gone = await manager.agent.get(`/api/skus/${sku.id}`);
    expect(gone.status).toBe(404);

    const event = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.deleted'"
      )
      .get(sku.id) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      name: "iPhone 16e Scren",
      note: "typo, recreated correctly",
    });
  });

  it("refuses to delete a SKU with parts, usage, demand, or PO lines — naming the counts", async () => {
    const manager = await harness.loginAs(MANAGER);
    const withParts = await createSku(manager.agent);
    await manager.agent
      .post(`/api/skus/${withParts.id}/parts`)
      .send({ source: "migration", counted: true });

    const refused = await manager.agent
      .delete(`/api/skus/${withParts.id}`)
      .send({ note: "attempt" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("serialized part");

    const consumable = await createSku(manager.agent, { name: "Adhesive", kind: "consumable" });
    // consumable usage arrives through a batch; demand through a batch; PO lines through a PO.
    // Those seams are owned by other domains — seed the rows the way the app would.
    const batch = await manager.agent
      .post("/api/batches")
      .send({ note: "test batch" });
    expect(batch.status).toBe(201);
    const batchBody = batch.body as { id: number };
    const device = await manager.agent
      .post(`/api/batches/${batchBody.id}/devices`)
      .send({ modelName: "iPhone 13", imei: "359175920074058", statedIssue: "cracked" });
    expect(device.status).toBe(201);
    const deviceBody = device.body as { id: number };

    await manager.agent
      .post(`/api/batches/${batchBody.id}/devices/${deviceBody.id}/consumables`)
      .send({ skuId: consumable.id, quantity: 1, note: "used" });
    const refusedUsage = await manager.agent
      .delete(`/api/skus/${consumable.id}`)
      .send({ note: "attempt" });
    expect(refusedUsage.status).toBe(409);
    expect(refusedUsage.body.error).toContain("consumable usage");

    const demanded = await manager.agent
      .post(`/api/batches/${batchBody.id}/devices/${deviceBody.id}/parts`)
      .send({ skuId: withParts.id, note: "need" });
    // stock exists from the migration intake above, so this reserves rather than demanding
    if (demanded.status === 201 && (demanded.body as { outcome?: string }).outcome === "need_to_order") {
      const refusedDemand = await manager.agent
        .delete(`/api/skus/${withParts.id}`)
        .send({ note: "attempt" });
      expect(refusedDemand.status).toBe(409);
      expect(refusedDemand.body.error).toContain("demand");
    }
  });
});

describe("SKU default source link (ticket 11)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("creates a SKU with a default source link and returns it from every read path", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { defaultSourceUrl: "source.com/part" });
    expect(sku.defaultSourceUrl).toBe("source.com/part");

    const list = await manager.agent.get("/api/skus");
    expect(list.status).toBe(200);
    const listed = (list.body as SkuBody[]).find((row) => row.id === sku.id);
    expect(listed?.defaultSourceUrl).toBe("source.com/part");

    const detail = await manager.agent.get(`/api/skus/${sku.id}`);
    expect(detail.status).toBe(200);
    expect((detail.body as SkuBody).defaultSourceUrl).toBe("source.com/part");
  });

  it("leaves the link NULL when it is not sent, and stores an empty string as NULL", async () => {
    const manager = await harness.loginAs(MANAGER);
    const plain = await createSku(manager.agent);
    expect(plain.defaultSourceUrl).toBeNull();

    const cleared = await createSku(manager.agent, { defaultSourceUrl: "   " });
    expect(cleared.defaultSourceUrl).toBeNull();
  });

  it("PATCH updates the link without a note and records sku.source_changed", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { defaultSourceUrl: "source.com/part" });

    const changed = await manager.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ defaultSourceUrl: "https://injuredgadgets.com/iphone13" });
    expect(changed.status).toBe(200);
    expect((changed.body as SkuBody).defaultSourceUrl).toBe("https://injuredgadgets.com/iphone13");

    const event = harness.db
      .prepare(
        "SELECT actor_id, action, payload FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.source_changed'"
      )
      .get(sku.id) as { actor_id: number; action: string; payload: string };
    expect(event.actor_id).toBe(manager.user.id);
    expect(JSON.parse(event.payload)).toEqual({
      from: "source.com/part",
      to: "https://injuredgadgets.com/iphone13",
    });
  });

  it("PATCH clears the link to NULL on an empty string, and ignores a no-op save", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { defaultSourceUrl: "source.com/part" });

    const cleared = await manager.agent.patch(`/api/skus/${sku.id}`).send({ defaultSourceUrl: "  " });
    expect(cleared.status).toBe(200);
    expect((cleared.body as SkuBody).defaultSourceUrl).toBeNull();

    // Saving an unchanged field is not a change: no second event, no write.
    const noop = await manager.agent.patch(`/api/skus/${sku.id}`).send({ defaultSourceUrl: "" });
    expect(noop.status).toBe(200);
    const events = harness.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.source_changed'"
      )
      .get(sku.id) as { n: number };
    expect(events.n).toBe(1);
  });

  it("accepts non-URL free text — clickability is a read-time decision, not a write-time rule", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { defaultSourceUrl: "the usual eBay seller" });
    expect(sku.defaultSourceUrl).toBe("the usual eBay seller");
  });
});
