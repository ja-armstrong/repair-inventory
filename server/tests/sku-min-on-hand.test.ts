import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

/**
 * The minimum on-hand quantity (CONTEXT.md: SKU): a serialized SKU may
 * declare the smallest on-hand stock the shop wants on the shelf — 0 by
 * default, meaning "no minimum". On-hand is the ONE definition in
 * parts/stock.ts (the count of Available units). When a SKU sits below its
 * minimum, the PO form's demand prompt lists it with the shortfall, the same
 * way it lists open Need to Order demand records.
 *
 * The rule is serialized-only, enforced at the write seams exactly like
 * buybackable (0016): a consumable has no units, so it can never carry a
 * minimum, and a serialized SKU must return its minimum to 0 before it can
 * change kind.
 */

const MANAGER = DEFAULT_MANAGER_EMAIL;

async function createSku(
  agent: LoggedInAgent["agent"],
  overrides: Record<string, unknown> = {},
): Promise<{ id: number; minOnHand: number; kind: "serialized" | "consumable" }> {
  const response = await agent.post("/api/skus").send({
    name: "iPhone 13 Screen",
    price: "109.99",
    kind: "serialized",
    ...overrides,
  });
  return response.body;
}

/** Bulk intake of Available serialized parts (migration source, counted). */
async function intakeParts(agent: LoggedInAgent["agent"], skuId: number, quantity: number) {
  const response = await agent
    .post(`/api/skus/${skuId}/parts`)
    .send({ source: "migration", quantity, counted: true });
  expect(response.status).toBe(201);
  return response.body.parts as Array<{ serial: string }>;
}

async function lowStock(agent: LoggedInAgent["agent"]) {
  const response = await agent.get("/api/purchase-orders/demand");
  expect(response.status).toBe(200);
  return response.body.lowStock as Array<{
    skuId: number;
    skuName: string;
    availableCount: number;
    minOnHand: number;
    shortfall: number;
  }>;
}

describe("POST /api/skus — minimum on-hand", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("defaults to 0 (no minimum) when absent", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    expect(sku.minOnHand).toBe(0);
    const row = harness.db.prepare("SELECT min_on_hand FROM skus WHERE id = ?").get(sku.id) as {
      min_on_hand: number;
    };
    expect(row.min_on_hand).toBe(0);
  });

  it("stores a declared minimum on a serialized SKU and records it on sku.created", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { minOnHand: 3 });
    expect(sku.minOnHand).toBe(3);

    const event = harness.db
      .prepare("SELECT payload FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.created'")
      .get(sku.id) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ minOnHand: 3 });
  });

  it("refuses a minimum on a consumable SKU — consumables have no units", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent.post("/api/skus").send({
      name: "Adhesive strips",
      price: "1.50",
      kind: "consumable",
      minOnHand: 2,
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/serialized SKUs only/i);
  });

  it("refuses negatives and non-integers", async () => {
    const manager = await harness.loginAs(MANAGER);
    for (const minOnHand of [-1, 1.5, "abc"]) {
      const response = await manager.agent
        .post("/api/skus")
        .send({ name: "Screen", price: "10", kind: "serialized", minOnHand });
      expect(response.status).toBe(400);
    }
  });
});

describe("PATCH /api/skus/:id — minimum on-hand", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("changes the minimum without a note and records sku.min_on_hand_changed", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);

    const set = await manager.agent.patch(`/api/skus/${sku.id}`).send({ minOnHand: 4 });
    expect(set.status).toBe(200);
    expect(set.body.minOnHand).toBe(4);

    const event = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'sku' AND entity_id = ? AND action = 'sku.min_on_hand_changed'"
      )
      .get(sku.id) as { payload: string };
    expect(JSON.parse(event.payload)).toEqual({ from: 0, to: 4 });
  });

  it("refuses a minimum on a consumable SKU", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { name: "Adhesive strips", kind: "consumable", price: "1.50" });
    const response = await manager.agent.patch(`/api/skus/${sku.id}`).send({ minOnHand: 2 });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/serialized SKUs only/i);
  });

  it("blocks a serialized → consumable kind change while a minimum stands", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { minOnHand: 2 });

    const refused = await manager.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ kind: "consumable", note: "entered as serialized by mistake" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/minimum on-hand/i);

    // Return the minimum to 0 first — then the kind change goes through.
    await manager.agent.patch(`/api/skus/${sku.id}`).send({ minOnHand: 0 });
    const allowed = await manager.agent
      .patch(`/api/skus/${sku.id}`)
      .send({ kind: "consumable", note: "entered as serialized by mistake" });
    expect(allowed.status).toBe(200);
    expect(allowed.body.kind).toBe("consumable");
  });
});

describe("GET /api/purchase-orders/demand — the below-minimum prompt", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("lists a serialized SKU below its minimum with the shortfall, and drops it once stock reaches the minimum", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { minOnHand: 3 });

    // Zero on hand: the whole minimum is the shortfall.
    let listed = await lowStock(manager.agent);
    expect(listed).toEqual([
      { skuId: sku.id, skuName: "iPhone 13 Screen", availableCount: 0, minOnHand: 3, shortfall: 3 },
    ]);

    // On hand is the count of AVAILABLE units — one intake lifts the stock
    // and shrinks the shortfall to 2.
    await intakeParts(manager.agent, sku.id, 1);
    listed = await lowStock(manager.agent);
    expect(listed).toEqual([
      { skuId: sku.id, skuName: "iPhone 13 Screen", availableCount: 1, minOnHand: 3, shortfall: 2 },
    ]);

    // Reaching the minimum removes the row — receiving is what settles it.
    await intakeParts(manager.agent, sku.id, 2);
    listed = await lowStock(manager.agent);
    expect(listed).toEqual([]);
  });

  it("never lists SKUs without a minimum — 0 means no minimum, not 'order everything'", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent, { name: "Battery", price: "39.50" });
    const listed = await lowStock(manager.agent);
    expect(listed).toEqual([]);
  });

  it("only counts Available units as on hand — spoken-for stock is not on the shelf", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent, { minOnHand: 2 });
    const parts = await intakeParts(manager.agent, sku.id, 2);

    // One unit written off: only one Available unit remains, so the SKU is
    // still one short.
    const written = await manager.agent
      .post(`/api/parts/${parts[0].serial}/status`)
      .send({ status: "unavailable", note: "failed audit" });
    expect(written.status).toBe(200);

    const listed = await lowStock(manager.agent);
    expect(listed).toEqual([
      { skuId: sku.id, skuName: "iPhone 13 Screen", availableCount: 1, minOnHand: 2, shortfall: 1 },
    ]);
  });

  it("lists consumable SKUs never — the write seams already refuse the field", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent, { name: "Adhesive strips", kind: "consumable", price: "1.50" });
    // Belt-and-braces at the read seam: even a row that somehow carries a
    // minimum cannot be prompted for a consumable — the query filters on kind.
    harness.db.prepare("UPDATE skus SET min_on_hand = 5 WHERE kind = 'consumable'").run();
    const listed = await lowStock(manager.agent);
    expect(listed).toEqual([]);
  });
});
