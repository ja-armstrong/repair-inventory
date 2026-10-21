import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  FakeClock,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

/**
 * Ticket 27 — buybacks (CONTEXT.md: Buyback, Buybackable, Buyback Order):
 * a supplier sell-back flow mirroring RMA. The SKU flag routes removals to
 * the Buyback pool by default; orders ship the pool; Complete settles every
 * part Unavailable for ONE hand-entered order value (the recovery revenue —
 * no per-part dispositions, spec: buyback-order-value).
 */

const SCREEN = { name: "iPhone 13 Screen", price: "109.99", kind: "serialized" };

interface PartJson {
  id: number;
  serial: string;
  status: string;
  statusLabel: string;
  sku: { buybackable: boolean };
}

interface OrderPartBody {
  partId: number;
  serial: string;
  skuName: string;
}

interface OrderBody {
  id: number;
  number: number;
  status: string;
  statusLabel: string;
  partCount: number;
  orderValueCents: number | null;
  parts: OrderPartBody[];
  events: Array<{ action: string; payload: Record<string, unknown> | null }>;
}

async function createSku(agent: Agent, overrides: Record<string, unknown> = {}) {
  const response = await agent.post("/api/skus").send({ ...SCREEN, ...overrides });
  expect(response.status).toBe(201);
  return response.body as { id: number; buybackable: boolean };
}

async function intakeParts(agent: Agent, skuId: number, count: number): Promise<string[]> {
  const response = await agent.post(`/api/skus/${skuId}/parts`).send({
    source: "migration",
    quantity: count,
    counted: false,
  });
  expect(response.status).toBe(201);
  return (response.body.parts as Array<{ serial: string }>).map((part) => part.serial);
}

/** The batch-parts removal path: part removed from a device to a destination. */
async function setupAttachedPart(harness: TestHarness, agent: Agent, buybackable: boolean) {
  const sku = await createSku(agent, { buybackable });
  const [serial] = await intakeParts(agent, sku.id, 1);
  const batch = await agent.post("/api/batches").send({ note: "buyback removal flow" });
  expect(batch.status).toBe(201);
  const batchId = (batch.body as { id: number }).id;
  const device = await agent
    .post(`/api/batches/${batchId}/devices`)
    .send({ modelName: "iPhone 13", statedIssue: "Cracked screen", imei: "359175920074058" });
  expect(device.status).toBe(201);
  const deviceId = (device.body as { id: number }).id;
  await agent.post(`/api/batches/${batchId}/devices/${deviceId}/parts`).send({ skuId: sku.id });
  const parts = await agent.get(`/api/batches/${batchId}/parts`);
  const attachment = (
    (parts.body as { devices: Array<{ parts: Array<{ id: number }> }> }).devices[0].parts
  )[0];
  return { sku, serial, batchId, deviceId, attachmentId: attachment.id as number };
}

async function removePart(
  agent: Agent,
  batchId: number,
  deviceId: number,
  attachmentId: number,
  body: Record<string, unknown>
) {
  return agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/parts/${attachmentId}/remove`)
    .send(body);
}

async function partDetail(agent: Agent, serial: string): Promise<PartJson> {
  const response = await agent.get(`/api/parts/${serial}`);
  expect(response.status).toBe(200);
  return response.body as PartJson;
}

async function createBuybackOrder(agent: Agent, note = "Screens to MobileSentrix"): Promise<OrderBody> {
  const response = await agent.post("/api/buyback-orders").send({ note });
  expect(response.status).toBe(201);
  return response.body as OrderBody;
}

describe("the buybackable SKU flag", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("defaults off; turning it on requires a note and records sku.buybackable_changed", async () => {
    const sku = await createSku(tech.agent);
    expect(sku.buybackable).toBe(false);

    const noNote = await tech.agent.patch(`/api/skus/${sku.id}`).send({ buybackable: true });
    expect(noNote.status).toBe(400);

    const changed = await tech.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ buybackable: true, note: "enrolled in MobileSentrix's LCD program" });
    expect(changed.status).toBe(200);
    expect((changed.body as { buybackable: boolean }).buybackable).toBe(true);

    const event = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.buybackable_changed'"
      )
      .get(sku.id) as { payload: string };
    expect(JSON.parse(event.payload)).toEqual({
      from: false,
      to: true,
      note: "enrolled in MobileSentrix's LCD program",
    });
  });

  it("is refused on consumable SKUs, and a buybackable SKU cannot become consumable", async () => {
    const consumable = await createSku(tech.agent, {
      name: "Adhesive strips",
      price: "1.50",
      kind: "consumable",
    });
    const refused = await tech.agent
      .patch(`/api/skus/${consumable.id}`)
      .send({ buybackable: true, note: "no" });
    expect(refused.status).toBe(409);

    const buybackable = await createSku(tech.agent, { buybackable: true });
    const flipped = await tech.agent
      .patch(`/api/skus/${buybackable.id}`)
      .send({ kind: "consumable", note: "correction" });
    expect(flipped.status).toBe(409);
    expect((flipped.body as { error: string }).error).toContain("buybackable");
  });

  it("re-toggling works — off again with a note", async () => {
    const sku = await createSku(tech.agent, { buybackable: true });
    const off = await tech.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ buybackable: false, note: "program dropped us" });
    expect(off.status).toBe(200);
    expect((off.body as { buybackable: boolean }).buybackable).toBe(false);
  });
});

describe("removal destination is always explicit (ticket 02)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("a buybackable part removed WITHOUT a destination is refused — no server-side default, ever", async () => {
    const setup = await setupAttachedPart(harness, tech.agent, true);
    const refused = await removePart(tech.agent, setup.batchId, setup.deviceId, setup.attachmentId, {
      note: "screen came off in one piece",
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toContain("destination");

    // Nothing was removed: the part is still Reserved on the device.
    const part = await partDetail(tech.agent, setup.serial);
    expect(part.status).toBe("reserved");
    const pool = await tech.agent.get("/api/buyback-parts");
    expect((pool.body as Array<{ serial: string }>).map((entry) => entry.serial)).not.toContain(
      setup.serial
    );
  });

  it("an explicit destination still removes — Damaged by Tech with its note", async () => {
    const setup = await setupAttachedPart(harness, tech.agent, true);
    const removed = await removePart(tech.agent, setup.batchId, setup.deviceId, setup.attachmentId, {
      destination: "damaged_by_tech",
      note: "screen too destroyed to sell",
    });
    expect(removed.status).toBe(200);
    const part = await partDetail(tech.agent, setup.serial);
    expect(part.status).toBe("damaged_by_tech");

    const pool = await tech.agent.get("/api/buyback-parts");
    expect((pool.body as Array<{ serial: string }>).map((entry) => entry.serial)).not.toContain(
      setup.serial
    );
  });

  it("a non-buybackable part requires an explicit destination too — every SKU, no exceptions", async () => {
    const setup = await setupAttachedPart(harness, tech.agent, false);
    const refused = await removePart(tech.agent, setup.batchId, setup.deviceId, setup.attachmentId, {
      note: "no destination given",
    });
    expect(refused.status).toBe(400);
  });

  it("setting Buyback on a non-buybackable SKU's part is refused; buybackable SKUs can via the part page", async () => {
    const plainSku = await createSku(tech.agent);
    const [plainSerial] = await intakeParts(tech.agent, plainSku.id, 1);
    const refused = await tech.agent
      .post(`/api/parts/${plainSerial}/status`)
      .send({ status: "buyback", note: "wants money back" });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain("not buybackable");

    const goodSku = await createSku(tech.agent, { buybackable: true });
    const [goodSerial] = await intakeParts(tech.agent, goodSku.id, 1);
    const set = await tech.agent
      .post(`/api/parts/${goodSerial}/status`)
      .send({ status: "buyback", note: "spare screen worth selling back" });
    expect(set.status).toBe(200);
    expect((set.body as PartJson).status).toBe("buyback");
  });
});

describe("the buyback pool and its override", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  async function pooledPart(): Promise<{ serial: string; partId: number }> {
    const setup = await setupAttachedPart(harness, tech.agent, true);
    const removed = await removePart(tech.agent, setup.batchId, setup.deviceId, setup.attachmentId, {
      destination: "buyback",
      note: "came off clean",
    });
    expect(removed.status).toBe(200);
    const detail = await partDetail(tech.agent, setup.serial);
    return { serial: setup.serial, partId: detail.id };
  }

  it("a pooled part can be overridden out of the pool — loudly, with a note", async () => {
    const { serial, partId } = await pooledPart();

    const noNote = await tech.agent
      .post(`/api/buyback-parts/${partId}/override`)
      .send({ destination: "available" });
    expect(noNote.status).toBe(400);

    const overridden = await tech.agent
      .post(`/api/buyback-parts/${partId}/override`)
      .send({ destination: "rma", note: "actually a warranty return — vendor credit instead" });
    expect(overridden.status).toBe(200);

    const part = await partDetail(tech.agent, serial);
    expect(part.status).toBe("rma");
    const event = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'part' AND entity_id = ? AND action = 'part.status_changed' ORDER BY id DESC LIMIT 1"
      )
      .get(partId) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ from: "buyback", to: "rma" });

    const pool = await tech.agent.get("/api/buyback-parts");
    expect((pool.body as Array<{ serial: string }>).map((entry) => entry.serial)).not.toContain(serial);
  });

  it("a pooled part can be written off from the pool (unavailable)", async () => {
    const { partId } = await pooledPart();
    const overridden = await tech.agent
      .post(`/api/buyback-parts/${partId}/override`)
      .send({ destination: "unavailable", note: "cracked during handling — written off" });
    expect(overridden.status).toBe(200);
    const row = harness.db
      .prepare("SELECT status FROM serialized_parts WHERE id = ?")
      .get(partId) as { status: string };
    expect(row.status).toBe("unavailable");
  });
});

describe("the buyback order lifecycle", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  async function pooledParts(count: number): Promise<string[]> {
    const serials: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const setup = await setupAttachedPart(harness, tech.agent, true);
      await removePart(tech.agent, setup.batchId, setup.deviceId, setup.attachmentId, {
        destination: "buyback",
        note: "came off clean",
      });
      serials.push(setup.serial);
    }
    return serials;
  }

  it("create requires a note; scanning demands Buyback-status parts; one open order per part", async () => {
    const noNote = await tech.agent.post("/api/buyback-orders").send({});
    expect(noNote.status).toBe(400);

    const order = await createBuybackOrder(tech.agent);
    expect(order.status).toBe("in_transit");
    expect(order.statusLabel).toBe("In-Transit");

    const plainSku = await createSku(tech.agent);
    const [plainSerial] = await intakeParts(tech.agent, plainSku.id, 1);
    const refused = await tech.agent
      .post(`/api/buyback-orders/${order.id}/parts`)
      .send({ serial: plainSerial });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain("only Buyback-status parts");

    const [pooled] = await pooledParts(1);
    const added = await tech.agent.post(`/api/buyback-orders/${order.id}/parts`).send({ serial: pooled });
    expect(added.status).toBe(201);
    expect((added.body as OrderBody).partCount).toBe(1);

    const again = await tech.agent
      .post(`/api/buyback-orders/${order.id}/parts`)
      .send({ serial: pooled });
    expect(again.status).toBe(409);

    // A second order cannot claim the same pooled part.
    const order2 = await createBuybackOrder(tech.agent);
    const elsewhere = await tech.agent
      .post(`/api/buyback-orders/${order2.id}/parts`)
      .send({ serial: pooled });
    expect(elsewhere.status).toBe(409);
    expect((elsewhere.body as { error: string }).error).toContain("only one open buyback order");
  });

  it("Complete settles every part Unavailable for one hand-entered order value", async () => {
    const [a, b] = await pooledParts(2);
    const order = await createBuybackOrder(tech.agent);
    await tech.agent.post(`/api/buyback-orders/${order.id}/parts`).send({ serial: a });
    await tech.agent.post(`/api/buyback-orders/${order.id}/parts`).send({ serial: b });

    // A settlement never guesses: the value is required, even when it is 0.
    const noValue = await tech.agent
      .post(`/api/buyback-orders/${order.id}/complete`)
      .send({ note: "settled" });
    expect(noValue.status).toBe(400);

    const badValue = await tech.agent
      .post(`/api/buyback-orders/${order.id}/complete`)
      .send({ note: "settled", orderValue: "12.345" });
    expect(badValue.status).toBe(400);
    expect((badValue.body as { error: string }).error).toContain("order's value");

    const negative = await tech.agent
      .post(`/api/buyback-orders/${order.id}/complete`)
      .send({ note: "settled", orderValue: "-5" });
    expect(negative.status).toBe(400);

    const completed = await tech.agent.post(`/api/buyback-orders/${order.id}/complete`).send({
      note: "MobileSentrix settled the shipment",
      orderValue: "18.50",
    });
    expect(completed.status).toBe(200);
    const body = completed.body as OrderBody;
    expect(body.status).toBe("complete");
    expect(body.orderValueCents).toBe(1850);
    // No per-part settlement exists anywhere: the parts list carries no
    // disposition or price fields, and no per-part settled events fired.
    expect(body.parts.map((part) => Object.keys(part).sort())).toEqual([
      ["addedAt", "addedByEmail", "partId", "price", "priceCents", "serial", "skuId", "skuName"],
      ["addedAt", "addedByEmail", "partId", "price", "priceCents", "serial", "skuId", "skuName"],
    ]);
    const settledEvent = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'buyback' AND entity_id = ? AND action = 'buyback.settled'"
      )
      .get(order.id) as { payload: string };
    expect(JSON.parse(settledEvent.payload)).toEqual({ orderValueCents: 1850 });

    for (const serial of [a, b]) {
      const row = harness.db
        .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
        .get(serial) as { status: string };
      expect(row.status).toBe("unavailable");
    }

    const double = await tech.agent
      .post(`/api/buyback-orders/${order.id}/complete`)
      .send({ note: "again", orderValue: "1" });
    expect(double.status).toBe(409);

    const afterComplete = await tech.agent
      .post(`/api/buyback-orders/${order.id}/parts`)
      .send({ serial: a });
    expect(afterComplete.status).toBe(409);
  });

  it("an order with no parts can't be completed — scan parts onto it first", async () => {
    const order = await createBuybackOrder(tech.agent);
    const empty = await tech.agent
      .post(`/api/buyback-orders/${order.id}/complete`)
      .send({ note: "settled", orderValue: "5" });
    expect(empty.status).toBe(400);
    expect((empty.body as { error: string }).error).toContain("no parts");
  });

  it("a part attached to an in-transit buyback order refuses bare status changes — the shipment owns it", async () => {
    const [serial] = await pooledParts(1);
    const order = await createBuybackOrder(tech.agent);
    await tech.agent.post(`/api/buyback-orders/${order.id}/parts`).send({ serial });

    const refused = await tech.agent
      .post(`/api/parts/${serial}/status`)
      .send({ status: "available", note: "changed my mind" });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain(`buyback order #${order.number}`);
  });

  it("the order value rides on the order summary — NULL while open, the entered amount after", async () => {
    const [serial] = await pooledParts(1);
    const order = await createBuybackOrder(tech.agent);
    await tech.agent.post(`/api/buyback-orders/${order.id}/parts`).send({ serial });
    const before = (await tech.agent.get(`/api/buyback-orders/${order.id}`)).body as OrderBody;
    expect(before.orderValueCents).toBeNull();
    await tech.agent.post(`/api/buyback-orders/${order.id}/complete`).send({
      note: "settled",
      orderValue: "20",
    });
    const after = (await tech.agent.get(`/api/buyback-orders/${order.id}`)).body as OrderBody;
    expect(after.orderValueCents).toBe(2000);
  });
});

describe("search and the buyback-recovery report", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;
  let manager: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("search finds a buyback order by number", async () => {
    const order = await createBuybackOrder(tech.agent);
    const search = await tech.agent.get(`/api/search?q=${order.number}`);
    expect(search.status).toBe(200);
    const results = (search.body as {
      results: { buybackOrders: Array<{ id: number; number: number; statusLabel: string }> };
    }).results;
    expect(results.buybackOrders.map((entry) => entry.id)).toContain(order.id);
    expect(results.buybackOrders[0].statusLabel).toBe("In-Transit");
  });

  it("the buyback-recovery CSV lists completed orders with their entered values and the total", async () => {
    const setup = await setupAttachedPart(harness, tech.agent, true);
    await removePart(tech.agent, setup.batchId, setup.deviceId, setup.attachmentId, {
      destination: "buyback",
      note: "came off clean",
    });
    const order = await createBuybackOrder(tech.agent);
    await tech.agent.post(`/api/buyback-orders/${order.id}/parts`).send({ serial: setup.serial });
    await tech.agent.post(`/api/buyback-orders/${order.id}/complete`).send({
      note: "settled",
      orderValue: "22.00",
    });

    const csv = await manager.agent.get("/api/reports/buyback-recovery?from=2026-09-24&to=2026-09-24");
    expect(csv.status).toBe(200);
    const text = csv.text as string;
    expect(text).toContain("Buyback recovery,2026-09-24,2026-09-24");
    expect(text).toContain(`Buyback #${order.number}`);
    expect(text).toContain("22.00");
    expect(text).toContain("Total,,22.00");
    // Order granularity: no per-part serial or SKU lines.
    expect(text).not.toContain(setup.serial);
  });

  it("a buyback-pool part is exempt from the audit's due list, like RMA-bin parts", async () => {
    const setup = await setupAttachedPart(harness, tech.agent, true);
    await removePart(tech.agent, setup.batchId, setup.deviceId, setup.attachmentId, {
      destination: "buyback",
      note: "came off clean",
    });

    // Ticket 02: only a manager may open a window — the tech under test
    // scans nothing here; the point is the buyback-pool exemption.
    const opened = await manager.agent.post("/api/audits").send({});
    expect(opened.status).toBe(201);
    const detail = await tech.agent.get(`/api/audits/${(opened.body as { id: number }).id}`);
    const due = (detail.body as { parts: { due: Array<{ serial: string }> } }).parts.due;
    expect(due.map((entry) => entry.serial)).not.toContain(setup.serial);
  });
});

describe("open buyback orders carry an estimated recovery (ticket 29)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });
  afterEach(() => harness.close());

  it("the summary exposes the parts-value sum and a 10% estimate on the open order", async () => {
    const sku = await createSku(tech.agent, { buybackable: true });
    const [serial] = await intakeParts(tech.agent, sku.id, 1);
    await tech.agent.post(`/api/parts/${serial}/status`).send({ status: "buyback", note: "slated" });
    const order = await createBuybackOrder(tech.agent);
    const response = await tech.agent
      .post(`/api/buyback-orders/${order.id}/parts`)
      .send({ serial });
    // One 109.99 screen: the estimate is 10% = 10.9999 -> 11.00 (rounded cents).
    expect(response.body.partsValueCents).toBe(10999);
    expect(response.body.estimatedValueCents).toBe(1100);
  });
});

describe("the order-value backfill (migration 0027, buyback-order-value spec)", () => {
  it("backfills complete orders with the sum of their recorded sale prices and leaves open orders NULL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "buyback-order-value-test-"));
    const db = openDatabase(path.join(dir, "order-value.sqlite"));
    try {
      const clock = new FakeClock("2026-06-01T12:00:00.000Z");
      migrate(db, clock);

      // Rebuild the pre-0027 world: the first migrate already applied 0027,
      // so remove its ledger row, drop the column it added, and restore the
      // old-shape parts table with its settlement columns — the rows
      // inserted below are then shaped exactly as they existed before 0027.
      db.prepare("DELETE FROM migrations WHERE name = ?").run("0027-buyback-order-value.sql");
      db.exec("ALTER TABLE buyback_orders DROP COLUMN order_value_cents");
      db.exec("DROP TABLE buyback_order_parts");
      db.exec(`
        CREATE TABLE buyback_order_parts (
          id INTEGER PRIMARY KEY,
          buyback_order_id INTEGER NOT NULL REFERENCES buyback_orders(id),
          part_id INTEGER NOT NULL REFERENCES serialized_parts(id),
          added_at TEXT NOT NULL,
          added_by INTEGER NOT NULL REFERENCES users(id),
          disposition TEXT
            CHECK (disposition IS NULL OR disposition IN ('sold', 'rejected')),
          sale_price_cents INTEGER CHECK (sale_price_cents IS NULL OR sale_price_cents >= 0),
          disposition_note TEXT,
          settled_at TEXT,
          CHECK (
            disposition IS NULL
            OR (
              disposition_note IS NOT NULL
              AND (disposition = 'rejected' OR sale_price_cents IS NOT NULL)
            )
          )
        )
      `);

      const now = clock.now().toISOString();
      const userId = Number(
        db
          .prepare(
            "INSERT INTO users (email, role, active, created_at) VALUES ('seller@acme.co', 'tech', 1, ?)"
          )
          .run(now).lastInsertRowid
      );
      const skuId = Number(
        db
          .prepare(
            "INSERT INTO skus (name, price_cents, kind, buybackable, created_at, price_updated_at) VALUES ('Screen', 1000, 'serialized', 1, ?, ?)"
          )
          .run(now, now).lastInsertRowid
      );
      const insertPart = db.prepare(
        "INSERT INTO serialized_parts (sku_id, serial, status, last_counted_at, created_at) VALUES (?, ?, 'unavailable', NULL, ?)"
      );
      const partA = Number(insertPart.run(skuId, "P00001", now).lastInsertRowid);
      const partB = Number(insertPart.run(skuId, "P00002", now).lastInsertRowid);
      const partC = Number(insertPart.run(skuId, "P00003", now).lastInsertRowid);
      const partD = Number(insertPart.run(skuId, "P00004", now).lastInsertRowid);

      const insertOrder = db.prepare(
        "INSERT INTO buyback_orders (number, status, created_at, created_by, completed_at) VALUES (?, ?, ?, ?, ?)"
      );
      const complete = insertOrder.run(1, "complete", now, userId, "2026-05-01T12:00:00.000Z");
      const open = insertOrder.run(2, "in_transit", now, userId, null);

      const insertLine = db.prepare(
        `INSERT INTO buyback_order_parts
           (buyback_order_id, part_id, added_at, added_by, disposition, sale_price_cents, disposition_note, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      // The completed order: two sold parts with prices, one rejected at none.
      insertLine.run(complete.lastInsertRowid, partA, now, userId, "sold", 2000, "ok", now);
      insertLine.run(complete.lastInsertRowid, partB, now, userId, "sold", 500, "ok", now);
      insertLine.run(complete.lastInsertRowid, partC, now, userId, "rejected", null, "refused", now);
      // The open order: nothing settled yet.
      insertLine.run(open.lastInsertRowid, partD, now, userId, null, null, null, null);

      migrate(db, clock); // re-applies exactly 0027 against those rows

      const orders = db
        .prepare("SELECT id, status, order_value_cents FROM buyback_orders ORDER BY id")
        .all() as Array<{ id: number; status: string; order_value_cents: number | null }>;
      expect(orders).toHaveLength(2);
      expect(orders[0].order_value_cents).toBe(2500); // sold parts only; the rejected one is silent
      expect(orders[1].order_value_cents).toBeNull(); // still open — stamped at Complete

      // The parts table is the attachment record now.
      const columns = (
        db.prepare("PRAGMA table_info(buyback_order_parts)").all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).toEqual(["id", "buyback_order_id", "part_id", "added_at", "added_by"]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
