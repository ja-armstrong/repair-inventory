import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

/**
 * Ticket 28 — the per-device Price Add Limit (CONTEXT.md: Approval). The
 * manager sets an optional post-approval spend cap per device while the
 * batch is Awaiting approval; after the batch is Open a tech may add parts
 * and consumable usage up to that limit. The spend is DERIVED (active
 * attachments + consumable usage created after approved_at), never stored.
 */

const SCREEN = { name: "iPhone 13 Screen", price: "109.99", kind: "serialized" };
const BATTERY = { name: "iPhone 13 Battery", price: "30.00", kind: "serialized" };
const ADHESIVE = { name: "Adhesive strips", price: "1.50", kind: "consumable" };

interface DeviceJson {
  id: number;
  model: { name: string };
  imei: string | null;
  priceAddLimitCents: number;
}

interface DevicePartsJson {
  deviceId: number;
  parts: Array<{ id: number; priceCents: number; removedAt: string | null }>;
  partsCostCents: number;
  priceAddLimitCents: number;
  postApprovalSpendCents: number;
  priceAddRemainingCents: number;
}

async function createSku(agent: Agent, overrides: Record<string, unknown> = {}) {
  const response = await agent.post("/api/skus").send({ ...SCREEN, ...overrides });
  expect(response.status).toBe(201);
  return response.body as { id: number; name: string; priceCents: number };
}

async function intakeParts(
  agent: Agent,
  skuId: number,
  count: number,
  price?: string
): Promise<string[]> {
  const response = await agent.post(`/api/skus/${skuId}/parts`).send({
    source: "migration",
    quantity: count,
    counted: false,
    ...(price !== undefined ? { price } : {}),
  });
  expect(response.status).toBe(201);
  return (response.body.parts as Array<{ serial: string }>).map((part) => part.serial);
}

async function createBatch(agent: Agent) {
  const response = await agent.post("/api/batches").send({ note: "price add limit" });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function addDevice(agent: Agent, batchId: number, imei: string, modelName = "iPhone 13") {
  const response = await agent
    .post(`/api/batches/${batchId}/devices`)
    .send({ modelName, statedIssue: "Cracked screen", imei });
  expect(response.status).toBe(201);
  return response.body as { id: number };
}

async function addPart(
  agent: Agent,
  batchId: number,
  deviceId: number,
  body: Record<string, unknown>
) {
  return agent.post(`/api/batches/${batchId}/devices/${deviceId}/parts`).send(body);
}

async function deviceParts(agent: Agent, batchId: number, deviceId: number): Promise<DevicePartsJson> {
  const response = await agent.get(`/api/batches/${batchId}/parts`);
  expect(response.status).toBe(200);
  const devices = (response.body as { devices: DevicePartsJson[] }).devices;
  return devices.find((entry) => entry.deviceId === deviceId)!;
}

async function decide(
  agent: Agent,
  batchId: number,
  deviceId: number,
  body: Record<string, unknown>
) {
  return agent.post(`/api/batches/${batchId}/devices/${deviceId}/approval`).send(body);
}

async function approveBatch(agent: Agent, batchId: number, note = "Costs look right") {
  return agent.post(`/api/batches/${batchId}/approve`).send({ note });
}

/** An approved Open batch with one device; parts added pre-approval on request. */
async function setupOpenDevice(
  harness: TestHarness,
  agent: Agent,
  manager: Agent,
  options: { limitCents: number; preApprovalParts?: number } = { limitCents: 0 }
) {
  const sku = await createSku(agent);
  if (options.preApprovalParts) {
    await intakeParts(agent, sku.id, options.preApprovalParts + 1);
  }
  const batch = await createBatch(agent);
  const device = await addDevice(agent, batch.id, "359175920074058");
  for (let i = 0; i < (options.preApprovalParts ?? 0); i += 1) {
    const added = await addPart(agent, batch.id, device.id, { skuId: sku.id });
    expect(added.status).toBe(201);
  }
  const decided = await decide(manager, batch.id, device.id, {
    decision: "approved",
    priceAddLimitCents: options.limitCents,
  });
  expect(decided.status).toBe(200);
  expect((await approveBatch(manager, batch.id)).status).toBe(200);
  // Advance the fake clock past the approval instant: post-approval
  // additions are those created strictly AFTER approved_at.
  harness.clock.advance(1000);
  return { sku, batch, device };
}

describe("setting and changing the limit", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("is set with the approval decision; the event carries it; re-deciding without one keeps it", async () => {
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");

    const decided = await decide(manager.agent, batch.id, device.id, {
      decision: "approved",
      priceAddLimitCents: 15000,
    });
    expect(decided.status).toBe(200);
    expect((decided.body as DeviceJson).priceAddLimitCents).toBe(15000);

    // Re-deciding without a limit keeps the standing one.
    const again = await decide(manager.agent, batch.id, device.id, { decision: "approved" });
    expect((again.body as DeviceJson).priceAddLimitCents).toBe(15000);

    const event = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.approval_decided' ORDER BY id LIMIT 1"
      )
      .get(device.id) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      decision: "approved",
      priceAddLimitCents: 15000,
    });
  });

  it("refuses a negative or fractional limit", async () => {
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");
    for (const priceAddLimitCents of [-1, 10.5]) {
      const refused = await decide(manager.agent, batch.id, device.id, {
        decision: "approved",
        priceAddLimitCents,
      });
      expect(refused.status).toBe(400);
    }
  });

  it("a manager can change it in place later — device.price_limit_changed records old → new", async () => {
    const { batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 10000,
    });
    const changed = await manager.agent
      .patch(`/api/batches/${batch.id}/devices/${device.id}/price-limit`)
      .send({ priceAddLimitCents: 25000, note: "contract cap raised" });
    expect(changed.status).toBe(200);
    expect((changed.body as DeviceJson).priceAddLimitCents).toBe(25000);

    const event = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.price_limit_changed'"
      )
      .get(device.id) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      from: 10000,
      to: 25000,
      note: "contract cap raised",
    });
  });

  it("only a manager can change it; a Closed batch refuses", async () => {
    const { batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 10000,
    });
    const refused = await tech.agent
      .patch(`/api/batches/${batch.id}/devices/${device.id}/price-limit`)
      .send({ priceAddLimitCents: 25000 });
    expect(refused.status).toBe(403);

    await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/status`)
      .send({ repairStatus: "In progress" });
    await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/status`)
      .send({ repairStatus: "Repaired", resolutionNotes: "done" });
    expect((await manager.agent.post(`/api/batches/${batch.id}/close`).send({})).status).toBe(200);
    const closed = await manager.agent
      .patch(`/api/batches/${batch.id}/devices/${device.id}/price-limit`)
      .send({ priceAddLimitCents: 25000 });
    expect(closed.status).toBe(409);
    expect((closed.body as { error: string }).error).toContain("Closed");
  });
});

describe("the derived spend", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("pre-approval additions never count; post-approval additions and consumable usage do", async () => {
    const { batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 50000,
      preApprovalParts: 1,
    });

    // The pre-approval part (109.99) is covered by the approved total.
    let listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing.partsCostCents).toBe(10999);
    expect(listing.postApprovalSpendCents).toBe(0);
    expect(listing.priceAddRemainingCents).toBe(50000);

    // A consumable SKU for usage.
    const adhesive = await createSku(tech.agent, { ...ADHESIVE });
    const battery = await createSku(tech.agent, { ...BATTERY });
    await intakeParts(tech.agent, battery.id, 1);

    // Post-approval consumable usage counts.
    const usage = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/consumables`)
      .send({ skuId: adhesive.id, quantity: 2, note: "sealant" });
    expect(usage.status).toBe(201);
    listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing.postApprovalSpendCents).toBe(300); // 2 × 1.50

    // A post-approval part counts at its snapshot (effective) price.
    const added = await addPart(tech.agent, batch.id, device.id, {
      skuId: battery.id,
      note: "battery also shot",
    });
    expect(added.status).toBe(201);
    listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing.postApprovalSpendCents).toBe(3300); // 300 + 30.00
    expect(listing.partsCostCents).toBe(10999 + 3300);
  });

  it("a swap drops the removed part and counts the replacement", async () => {
    const { sku, batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 5000, // less than one screen — the swap must not be gated
      preApprovalParts: 1,
    });
    await intakeParts(tech.agent, sku.id, 1); // the replacement unit

    const listing = await deviceParts(tech.agent, batch.id, device.id);
    const attachmentId = listing.parts.find((part) => part.removedAt === null)!.id;
    const swapped = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/parts/${attachmentId}/swap`)
      .send({ destination: "available", note: "first unit was DOA" });
    expect(swapped.status).toBe(201); // not gated

    // The removed part drops out of the derived spend; the replacement
    // (added after approval) counts in full.
    const after = await deviceParts(tech.agent, batch.id, device.id);
    expect(after.postApprovalSpendCents).toBe(10999);
    expect(after.priceAddRemainingCents).toBe(5000 - 10999);
  });

  it("a price override counts at its effective price", async () => {
    const { batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 6000,
    });
    const battery = await createSku(tech.agent, { ...BATTERY });
    await intakeParts(tech.agent, battery.id, 1, "10.00"); // overridden at intake

    const added = await addPart(tech.agent, batch.id, device.id, {
      skuId: battery.id,
      note: "cheap aftermarket battery",
    });
    expect(added.status).toBe(201);
    const listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing.postApprovalSpendCents).toBe(1000); // the override, not the 30.00 catalog price
  });
});

describe("the gate", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("a within-limit tech addition succeeds and does not amend the approval", async () => {
    const { sku, batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 20000,
    });
    const battery = await createSku(tech.agent, { ...BATTERY });
    await intakeParts(tech.agent, battery.id, 1);

    const added = await addPart(tech.agent, batch.id, device.id, {
      skuId: battery.id,
      note: "battery also shot",
    });
    expect(added.status).toBe(201);

    // The tech's in-limit addition is pre-authorized by the limit — the
    // standing approval is not amended.
    const amendments = harness.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE action = 'batch.approval_amended'")
      .get() as { n: number };
    expect(amendments.n).toBe(0);
  });

  it("an equal-to-limit addition succeeds (up to)", async () => {
    const { sku, batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 10999, // exactly one screen
    });
    await intakeParts(tech.agent, sku.id, 1);

    const added = await addPart(tech.agent, batch.id, device.id, {
      skuId: sku.id,
      note: "second screen",
    });
    expect(added.status).toBe(201);
    const listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing.postApprovalSpendCents).toBe(10999);
    expect(listing.priceAddRemainingCents).toBe(0);
  });

  it("an over-limit addition is refused, naming limit, spend, cost, and the three options", async () => {
    const { sku, batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 5000,
    });
    await intakeParts(tech.agent, sku.id, 1);

    const refused = await addPart(tech.agent, batch.id, device.id, {
      skuId: sku.id,
      note: "one more screen",
    });
    expect(refused.status).toBe(409);
    const error = (refused.body as { error: string }).error;
    expect(error).toContain("109.99"); // this addition's cost
    expect(error).toContain("0.00"); // spend so far
    expect(error).toContain("50.00"); // the limit
    expect(error).toContain("a manager can add it in place");
    expect(error).toContain("Additional issues present");
    expect(error).toContain("Unrepairable");

    // Nothing was written.
    const listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing.parts).toHaveLength(0);
    expect(listing.postApprovalSpendCents).toBe(0);
  });

  it("a manager addition bypasses the gate and amends the approval", async () => {
    const { sku, batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 0, // a tech could add nothing
    });
    await intakeParts(tech.agent, sku.id, 1);

    const added = await addPart(manager.agent, batch.id, device.id, {
      skuId: sku.id,
      note: "manager override — the customer approved the extra screen",
    });
    expect(added.status).toBe(201);

    const amendment = harness.db
      .prepare("SELECT payload FROM events WHERE action = 'batch.approval_amended' ORDER BY id DESC LIMIT 1")
      .get() as { payload: string };
    expect(JSON.parse(amendment.payload)).toMatchObject({ totalCents: 10999 });
  });

  it("consumable usage is gated the same way", async () => {
    const { batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 500,
    });
    const adhesive = await createSku(tech.agent, { ...ADHESIVE });

    const within = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/consumables`)
      .send({ skuId: adhesive.id, quantity: 2, note: "sealant" }); // 3.00 ≤ 5.00
    expect(within.status).toBe(201);

    const over = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/consumables`)
      .send({ skuId: adhesive.id, quantity: 2, note: "more sealant" }); // 3.00 more > 2.00 left
    expect(over.status).toBe(409);
    expect((over.body as { error: string }).error).toContain("consumable usage (2 × Adhesive strips)");
    expect((over.body as { error: string }).error).toContain("3.00");
  });

  it("the default limit 0 preserves the pre-ticket behavior — a tech cannot add, but a Need to Order demand (no cost) still files", async () => {
    const { sku, batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 0,
    });
    await intakeParts(tech.agent, sku.id, 1);

    const refused = await addPart(tech.agent, batch.id, device.id, {
      skuId: sku.id,
      note: "trying to add",
    });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain("price add limit");

    // The demand path adds no cost — it is not gated.
    const emptySku = await createSku(tech.agent, { name: "No-stock Part", price: "50.00" });
    const demand = await addPart(tech.agent, batch.id, device.id, {
      skuId: emptySku.id,
      note: "screen is special-order",
    });
    expect(demand.status).toBe(201);
    expect((demand.body as { outcome: string }).outcome).toBe("need_to_order");
  });
});

describe("retiage resets the limit", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("the retriaged continuation row starts with the default limit (0)", async () => {
    const { batch, device } = await setupOpenDevice(harness, tech.agent, manager.agent, {
      limitCents: 20000,
    });
    await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/status`)
      .send({ repairStatus: "In progress" });
    const retriaged = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/status`)
      .send({ repairStatus: "Additional issues present", resolutionNotes: "board is shot" });
    expect(retriaged.status).toBe(200);
    const continuation = (retriaged.body as { retriagedTo?: { deviceId: number } }).retriagedTo!;

    const row = harness.db
      .prepare("SELECT price_add_limit_cents FROM devices WHERE id = ?")
      .get(continuation.deviceId) as { price_add_limit_cents: number };
    expect(row.price_add_limit_cents).toBe(0);
  });
});

