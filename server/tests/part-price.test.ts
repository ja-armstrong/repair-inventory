import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";
import { resolveEffectivePriceCents } from "../domains/parts/effective-price.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

/**
 * Ticket 23 — per-part price override (CONTEXT.md: Part Price). Each
 * serialized part carries its own price, defaulting to its SKU price.
 * Everything drives the HTTP API seam; the resolver's two branches are
 * pinned directly against the one module that owns the rule.
 */

const SCREEN = { name: "iPhone 13 Screen", price: "109.99", kind: "serialized" };

interface PartJson {
  id: number;
  serial: string;
  priceCents: number;
  price: string;
  overrideCents: number | null;
  priceOverridden: boolean;
  sku: { id: number; price: string; priceCents: number };
  events: Array<{ action: string; payload: Record<string, unknown> | null }>;
}

interface AttachmentJson {
  id: number;
  part: { serial: string };
  priceCents: number;
  price: string;
  priceOverridden: boolean;
  removedAt: string | null;
}

interface DevicePartsJson {
  deviceId: number;
  parts: AttachmentJson[];
  partsCostCents: number;
  partsCost: string;
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

async function partDetail(agent: Agent, serial: string): Promise<PartJson> {
  const response = await agent.get(`/api/parts/${serial}`);
  expect(response.status).toBe(200);
  return response.body as PartJson;
}

async function createBatch(agent: Agent) {
  const response = await agent.post("/api/batches").send({ note: "price-override tests" });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function addDevice(agent: Agent, batchId: number, imei: string) {
  const response = await agent
    .post(`/api/batches/${batchId}/devices`)
    .send({ modelName: "iPhone 13", statedIssue: "Cracked screen", imei });
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

async function deviceParts(
  agent: Agent,
  batchId: number,
  deviceId: number
): Promise<DevicePartsJson> {
  const response = await agent.get(`/api/batches/${batchId}/parts`);
  expect(response.status).toBe(200);
  const devices = (response.body as { devices: DevicePartsJson[] }).devices;
  return devices.find((entry) => entry.deviceId === deviceId)!;
}

/** Ticket 25: decide every undecided device (approved) before the batch can open. */
async function decideAll(agent: Agent, batchId: number): Promise<void> {
  const detail = await agent.get(`/api/batches/${batchId}`);
  const devices = (detail.body as { devices: Array<{ id: number; approvalDecision: string | null }> }).devices;
  for (const device of devices) {
    if (device.approvalDecision !== "approved") {
      await agent.post(`/api/batches/${batchId}/devices/${device.id}/approval`).send({ decision: "approved" });
    }
  }
}

async function approveBatch(agent: Agent, batchId: number) {
  await decideAll(agent, batchId);
  return agent.post(`/api/batches/${batchId}/approve`).send({ note: "Costs look right" });
}

async function closeBatch(agent: Agent, batchId: number) {
  return agent.post(`/api/batches/${batchId}/close`).send({});
}

async function setRepairStatus(
  agent: Agent,
  batchId: number,
  deviceId: number,
  repairStatus: string,
  resolutionNotes?: string
) {
  return agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/status`)
    .send(resolutionNotes === undefined ? { repairStatus } : { repairStatus, resolutionNotes });
}

describe("effective price resolution (the one module)", () => {
  it("uses the SKU price when there is no override and the override when there is one", () => {
    expect(resolveEffectivePriceCents(null, 10999)).toBe(10999);
    expect(resolveEffectivePriceCents(5000, 10999)).toBe(5000);
    expect(resolveEffectivePriceCents(10999, 10999)).toBe(10999);
  });
});

describe("per-part price at intake and on the part detail", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("a part intaken without a price follows the SKU price (no override)", async () => {
    const sku = await createSku(tech.agent);
    const [serial] = await intakeParts(tech.agent, sku.id, 1);
    const part = await partDetail(tech.agent, serial);
    expect(part.priceCents).toBe(10999);
    expect(part.price).toBe("109.99");
    expect(part.overrideCents).toBeNull();
    expect(part.priceOverridden).toBe(false);
  });

  it("intake with a price stamps the override; the detail shows the part price with the SKU price beside it", async () => {
    const sku = await createSku(tech.agent);
    const [serial] = await intakeParts(tech.agent, sku.id, 1, "50");
    const part = await partDetail(tech.agent, serial);
    expect(part.priceCents).toBe(5000);
    expect(part.price).toBe("50.00");
    expect(part.overrideCents).toBe(5000);
    expect(part.priceOverridden).toBe(true);
    expect(part.sku.price).toBe("109.99");

    const added = part.events.find((event) => event.action === "part.added");
    expect(added?.payload).toMatchObject({ priceCents: 5000 });
  });

  it("an invalid intake price is refused and nothing is created", async () => {
    const sku = await createSku(tech.agent);
    const response = await tech.agent
      .post(`/api/skus/${sku.id}/parts`)
      .send({ source: "salvage", note: "donor board", price: "12.345" });
    expect(response.status).toBe(400);
    const remaining = harness.db
      .prepare("SELECT COUNT(*) AS n FROM serialized_parts WHERE sku_id = ?")
      .get(sku.id) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("the part-detail price change requires a note and records part.price_changed with old → new", async () => {
    const sku = await createSku(tech.agent);
    const [serial] = await intakeParts(tech.agent, sku.id, 1);

    const noNote = await tech.agent.post(`/api/parts/${serial}/price`).send({ price: "50" });
    expect(noNote.status).toBe(400);

    const changed = await tech.agent
      .post(`/api/parts/${serial}/price`)
      .send({ price: "50", note: "bought this unit outright on eBay" });
    expect(changed.status).toBe(200);
    const body = changed.body as PartJson;
    expect(body.priceCents).toBe(5000);
    expect(body.priceOverridden).toBe(true);

    const event = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'part' AND action = 'part.price_changed' ORDER BY id DESC LIMIT 1"
      )
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({
      serial,
      from: 10999,
      to: 5000,
      overrideFrom: null,
      overrideTo: 5000,
      skuPriceCents: 10999,
      note: "bought this unit outright on eBay",
    });
  });

  it("an invalid re-price amount is refused", async () => {
    const sku = await createSku(tech.agent);
    const [serial] = await intakeParts(tech.agent, sku.id, 1);
    const response = await tech.agent
      .post(`/api/parts/${serial}/price`)
      .send({ price: "-1", note: "no" });
    expect(response.status).toBe(400);
  });
});

describe("snapshot at reservation uses the effective price", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("a part overridden at intake is reserved at its override, not the SKU price", async () => {
    const sku = await createSku(tech.agent);
    const [serial] = await intakeParts(tech.agent, sku.id, 1, "50");
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, "359175920074058");

    const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    expect(added.status).toBe(201);

    const listing = await deviceParts(tech.agent, batch.id, device.id);
    // An overridden part's cost differs from the SKU price — the snapshot
    // mechanism is unchanged, the captured number is the effective one.
    expect(listing.partsCostCents).toBe(5000);
    expect(listing.partsCost).toBe("50.00");
    expect(listing.parts[0].priceOverridden).toBe(true);

    const detail = await partDetail(tech.agent, serial);
    expect(detail.priceCents).toBe(5000);
  });

  it("add-part with a price stamps the override on the reserved unit and prices the device with it", async () => {
    const sku = await createSku(tech.agent);
    await intakeParts(tech.agent, sku.id, 1);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, "359175920074058");

    const added = await addPart(tech.agent, batch.id, device.id, {
      skuId: sku.id,
      price: "75.50",
      note: "sourced from eBay at $75.50",
    });
    expect(added.status).toBe(201);
    const attachment = (added.body as { attachment: AttachmentJson }).attachment;
    expect(attachment.priceCents).toBe(7550);
    expect(attachment.priceOverridden).toBe(true);

    const listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing.partsCostCents).toBe(7550);

    const serial = (await partDetail(tech.agent, attachment.part.serial)).serial;
    const row = harness.db
      .prepare("SELECT price_cents FROM serialized_parts WHERE serial = ?")
      .get(serial) as { price_cents: number };
    expect(row.price_cents).toBe(7550);
  });

  it("add-part with a price but no Available stock is refused loudly — the demand is not created", async () => {
    const sku = await createSku(tech.agent); // no stock intaken
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, "359175920074058");

    const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id, price: "75" });
    expect(added.status).toBe(400);
    expect((added.body as { error: string }).error).toContain("no stock was Available");

    const demands = harness.db
      .prepare("SELECT COUNT(*) AS n FROM demand_records WHERE sku_id = ?")
      .get(sku.id) as { n: number };
    expect(demands.n).toBe(0);
  });

  it("swapping in an overridden unit snapshots the replacement's own effective price", async () => {
    const sku = await createSku(tech.agent);
    // Unit 1 plain, unit 2 overridden at intake (oldest-first pick: unit 1
    // reserves first; the swap pulls unit 2 as the replacement).
    const [plain, overridden] = await intakeParts(tech.agent, sku.id, 2, undefined);
    await tech.agent
      .post(`/api/parts/${overridden}/price`)
      .send({ price: "42", note: "eBay unit" });
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, "359175920074058");

    await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    const before = await deviceParts(tech.agent, batch.id, device.id);
    const attachmentId = before.parts[0].id;
    const swapped = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/parts/${attachmentId}/swap`)
      .send({ destination: "available", note: "first unit scratched" });
    expect(swapped.status).toBe(201);

    const listing = await deviceParts(tech.agent, batch.id, device.id);
    const active = listing.parts.filter((part) => part.removedAt === null);
    expect(active).toHaveLength(1);
    expect(active[0].part.serial).toBe(overridden);
    expect(active[0].priceCents).toBe(4200);
    expect(active[0].priceOverridden).toBe(true);
    expect(plain).toBeDefined();
  });
});

describe("PO receipt stamps the part's price with the received unit cost", () => {
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

  it("a received part is born with its price set to the line's unit cost", async () => {
    const sku = await createSku(tech.agent, { name: "Received Screen" });
    const created = await tech.agent.post("/api/purchase-orders").send({
      purpose: "price stamping",
      note: "opening note",
      lines: [{ skuId: sku.id, quantity: 1, unitPrice: "70.00" }],
    });
    expect(created.status).toBe(201);
    const poId = (created.body as { id: number }).id;
    await manager.agent.post(`/api/purchase-orders/${poId}/approve`).send({ note: "ok" });

    const detail = await tech.agent.get(`/api/purchase-orders/${poId}`);
    expect(detail.status).toBe(200);
    const serial = (detail.body as { expectedSerials: Array<{ serial: string }> }).expectedSerials[0]
      .serial;

    const received = await tech.agent
      .post(`/api/purchase-orders/${poId}/receive`)
      .send({ serial });
    expect(received.status).toBe(200);

    const part = await partDetail(tech.agent, serial);
    expect(part.priceCents).toBe(7000);
    expect(part.priceOverridden).toBe(true);
    expect(part.sku.priceCents).toBe(7000); // the catalog also refreshes to the unit cost

    const added = part.events.find((event) => event.action === "part.added");
    expect(added?.payload).toMatchObject({ priceCents: 7000 });
  });
});

describe("price locking against the carrying batch", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;
  let manager: LoggedInAgent;
  let sku: { id: number };
  let serial: string;
  let batch: { id: number; number: number };
  let device: { id: number };

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    sku = await createSku(tech.agent);
    [serial] = await intakeParts(tech.agent, sku.id, 1);
    batch = await createBatch(tech.agent);
    device = await addDevice(tech.agent, batch.id, "359175920074058");
    const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    expect(added.status).toBe(201);
  });

  afterEach(() => {
    harness.close();
  });

  it("an unattached part can be re-priced by any tech", async () => {
    const [spare] = await intakeParts(tech.agent, sku.id, 1);
    const changed = await tech.agent
      .post(`/api/parts/${spare}/price`)
      .send({ price: "33", note: "shelf unit bought cheap" });
    expect(changed.status).toBe(200);
    expect((changed.body as PartJson).priceCents).toBe(3300);
  });

  it("while the carrying batch is Awaiting approval, a tech may re-price — and the device's cost follows", async () => {
    const changed = await tech.agent
      .post(`/api/parts/${serial}/price`)
      .send({ price: "50", note: "eBay unit" });
    expect(changed.status).toBe(200);

    const listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing.partsCostCents).toBe(5000);
  });

  it("once the batch is approved a tech is refused — the refusal names the batch", async () => {
    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);
    const refused = await tech.agent
      .post(`/api/parts/${serial}/price`)
      .send({ price: "50", note: "eBay unit" });
    expect(refused.status).toBe(403);
    expect((refused.body as { error: string }).error).toContain(`batch #${batch.number}`);
    expect((refused.body as { error: string }).error).toContain("Open");
  });

  it("a manager's post-approval re-price requires the note, amends the approval, and moves the approved total", async () => {
    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);

    const noNote = await manager.agent.post(`/api/parts/${serial}/price`).send({ price: "50" });
    expect(noNote.status).toBe(400);

    const amended = await manager.agent
      .post(`/api/parts/${serial}/price`)
      .send({ price: "50", note: "the unit was sourced privately — re-costing it" });
    expect(amended.status).toBe(200);

    const listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing.partsCostCents).toBe(5000);

    const approvedRow = harness.db
      .prepare("SELECT approved_cost_cents FROM batches WHERE id = ?")
      .get(batch.id) as { approved_cost_cents: number };
    expect(approvedRow.approved_cost_cents).toBe(5000);

    const amendment = harness.db
      .prepare("SELECT payload FROM events WHERE action = 'batch.approval_amended' ORDER BY id DESC LIMIT 1")
      .get() as { payload: string };
    expect(JSON.parse(amendment.payload)).toMatchObject({
      previousTotalCents: 10999,
      totalCents: 5000,
      note: "the unit was sourced privately — re-costing it",
    });
  });

  it("a part on a Closed batch can no longer be re-priced — the refusal names the batch", async () => {
    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);
    const repaired = await setRepairStatus(
      tech.agent,
      batch.id,
      device.id,
      "In progress"
    );
    expect(repaired.status).toBe(200);
    const done = await setRepairStatus(
      tech.agent,
      batch.id,
      device.id,
      "Repaired",
      "screen replaced"
    );
    expect(done.status).toBe(200);
    expect((await closeBatch(manager.agent, batch.id)).status).toBe(200);

    const refused = await manager.agent
      .post(`/api/parts/${serial}/price`)
      .send({ price: "50", note: "too late" });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain(`batch #${batch.number}`);
    expect((refused.body as { error: string }).error).toContain("Closed");
  });
});
