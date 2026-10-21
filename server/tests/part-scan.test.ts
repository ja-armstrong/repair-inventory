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
 * Scan-to-add and scanned swap: a scanned serial names the EXACT unit. The
 * add-by-scan path is an alternative to the SKU pick (the unit's own SKU
 * row drives the add; it never files a Need to Order); the swap's scan
 * reserves that exact replacement instead of the oldest Available one.
 * Everything drives the HTTP API seam, per the project's single-test-seam
 * decision.
 */

const SCREEN = { name: "iPhone 13 Screen", price: "109.99", kind: "serialized" };

interface PartJson {
  id: number;
  serial: string;
  status: string;
  statusLabel: string;
}

interface AttachmentJson {
  id: number;
  part: PartJson;
  sku: { id: number; name: string };
  priceCents: number;
  priceOverridden: boolean;
  removedAt: string | null;
}

async function createSku(agent: Agent, overrides: Record<string, unknown> = {}) {
  const response = await agent.post("/api/skus").send({ ...SCREEN, ...overrides });
  expect(response.status).toBe(201);
  return response.body as { id: number };
}

/** Intakes `count` Available units of a serialized SKU; returns their serials. */
async function intakeParts(agent: Agent, skuId: number, count: number): Promise<string[]> {
  const response = await agent.post(`/api/skus/${skuId}/parts`).send({
    source: "migration",
    quantity: count,
    counted: false,
  });
  expect(response.status).toBe(201);
  return (response.body.parts as Array<{ serial: string }>).map((part) => part.serial);
}

async function createBatch(agent: Agent) {
  const response = await agent.post("/api/batches").send({ note: "scan paths" });
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

async function addPartBySku(agent: Agent, batchId: number, deviceId: number, skuId: number) {
  const response = await agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/parts`)
    .send({ skuId });
  expect(response.status).toBe(201);
  return response.body as { outcome: string; attachment: AttachmentJson };
}

async function addPartByScan(
  agent: Agent,
  batchId: number,
  deviceId: number,
  body: Record<string, unknown>
) {
  return agent.post(`/api/batches/${batchId}/devices/${deviceId}/parts`).send(body);
}

async function deviceParts(agent: Agent, batchId: number, deviceId: number) {
  const response = await agent.get(`/api/batches/${batchId}/parts`);
  expect(response.status).toBe(200);
  const body = response.body as { devices: Array<{ deviceId: number; parts: AttachmentJson[] }> };
  // The ACTIVE attachments only — the panel filters removed rows the same way.
  return body.devices
    .find((device) => device.deviceId === deviceId)!
    .parts.filter((part) => part.removedAt === null);
}

function partStatus(db: TestHarness["db"], serial: string): string {
  return (db.prepare("SELECT status FROM serialized_parts WHERE serial = ?").get(serial) as {
    status: string;
  }).status;
}

describe("scan-to-add: a scanned serial reserves that exact unit", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
  });

  afterEach(() => {
    harness.close();
  });

  it("reserves the SCANNED unit, not the oldest Available one", async () => {
    const sku = await createSku(manager.agent);
    const [oldest, newest] = await intakeParts(manager.agent, sku.id, 2);
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");

    const response = await addPartByScan(manager.agent, batch.id, device.id, { serial: newest });
    expect(response.status).toBe(201);
    expect(response.body.outcome).toBe("reserved");

    const parts = await deviceParts(manager.agent, batch.id, device.id);
    expect(parts).toHaveLength(1);
    expect(parts[0].part.serial).toBe(newest);

    // The scanned unit flipped to Reserved; the older unit is untouched.
    expect(partStatus(harness.db, newest)).toBe("reserved");
    expect(partStatus(harness.db, oldest)).toBe("available");
  });

  it("the scanned unit's SKU drives the add — no SKU pick is needed or allowed with it", async () => {
    const sku = await createSku(manager.agent);
    const [serial] = await intakeParts(manager.agent, sku.id, 1);
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");

    // Both together would let the scan and the SKU disagree — refused.
    const both = await addPartByScan(manager.agent, batch.id, device.id, {
      skuId: sku.id,
      serial,
    });
    expect(both.status).toBe(400);
    expect((both.body as { error: string }).error).toContain("not both");

    // Neither is also refused loudly.
    const neither = await addPartByScan(manager.agent, batch.id, device.id, {});
    expect(neither.status).toBe(400);

    // Scan alone works and attaches the right SKU.
    const response = await addPartByScan(manager.agent, batch.id, device.id, { serial });
    expect(response.status).toBe(201);
    const parts = await deviceParts(manager.agent, batch.id, device.id);
    expect(parts[0].sku.id).toBe(sku.id);
  });

  it("refuses an unknown serial (404) and a unit that is not Available (409) — never a silent fallback or a Need to Order", async () => {
    const sku = await createSku(manager.agent);
    const [serial] = await intakeParts(manager.agent, sku.id, 1);
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");

    const unknown = await addPartByScan(manager.agent, batch.id, device.id, {
      serial: "P999999",
    });
    expect(unknown.status).toBe(404);

    // Reserve the unit by SKU first, then scan it: it is no longer Available.
    await addPartBySku(manager.agent, batch.id, device.id, sku.id);
    const taken = await addPartByScan(manager.agent, batch.id, device.id, { serial });
    expect(taken.status).toBe(409);
    expect((taken.body as { error: string }).error).toContain("not Available");

    // The scan refusal created no Need to Order record and changed nothing.
    const demandRow = harness.db
      .prepare("SELECT COUNT(*) AS n FROM demand_records WHERE batch_id = ?")
      .get(batch.id) as { n: number };
    expect(demandRow.n).toBe(0);
    const parts = await deviceParts(manager.agent, batch.id, device.id);
    expect(parts).toHaveLength(1); // only the SKU-path attachment
  });

  it("the scanned unit's own price override is what the attachment snapshots", async () => {
    const sku = await createSku(manager.agent);
    const [serial] = await intakeParts(manager.agent, sku.id, 1);
    // Stamp the unit's own price override (ticket 23) directly at the part
    // price door — the scan path snapshots it like the SKU path does.
    const price = await manager.agent.post(`/api/parts/${serial}/price`).send({
      price: "79.00",
      note: "sourced from eBay",
    });
    expect(price.status).toBe(200);

    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");
    const response = await addPartByScan(manager.agent, batch.id, device.id, { serial });
    expect(response.status).toBe(201);

    const parts = await deviceParts(manager.agent, batch.id, device.id);
    expect(parts[0].priceCents).toBe(7900);
    expect(parts[0].priceOverridden).toBe(true);
  });
});

describe("scanned swap: the scanned serial is the replacement unit", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
  });

  afterEach(() => {
    harness.close();
  });

  it("swaps in the SCANNED unit — the other Available units are untouched", async () => {
    const sku = await createSku(manager.agent);
    const [first, second, third] = await intakeParts(manager.agent, sku.id, 3);
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");
    const attachment = await addPartBySku(manager.agent, batch.id, device.id, sku.id);
    expect(attachment.attachment.part.serial).toBe(first); // oldest wins unscanned

    const response = await manager.agent
      .post(
        `/api/batches/${batch.id}/devices/${device.id}/parts/${attachment.attachment.id}/swap`
      )
      .send({ destination: "available", note: "unit arrived cracked", serial: third });
    expect(response.status).toBe(201);

    const parts = await deviceParts(manager.agent, batch.id, device.id);
    expect(parts).toHaveLength(1);
    expect(parts[0].part.serial).toBe(third);

    // The old attachment closed as a swap, part to the destination.
    const oldAttachment = harness.db
      .prepare(
        `SELECT removal_reason, removed_to, removal_note FROM device_parts
          WHERE part_id = (SELECT id FROM serialized_parts WHERE serial = ?)`
      )
      .get(first) as { removal_reason: string; removed_to: string; removal_note: string };
    expect(oldAttachment).toEqual({
      removal_reason: "swap",
      removed_to: "available",
      removal_note: "unit arrived cracked",
    });

    // The old unit went to the destination; the middle unit was never picked.
    expect(partStatus(harness.db, first)).toBe("available");
    expect(partStatus(harness.db, second)).toBe("available");
    expect(partStatus(harness.db, third)).toBe("reserved");
  });

  it("refuses a scanned replacement of a different SKU — a swap must be same-SKU", async () => {
    const sku = await createSku(manager.agent);
    const other = await createSku(manager.agent, { name: "iPhone 14 Screen" });
    const [mine] = await intakeParts(manager.agent, sku.id, 1);
    const [theirs] = await intakeParts(manager.agent, other.id, 1);
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");
    const attachment = await addPartBySku(manager.agent, batch.id, device.id, sku.id);

    const refused = await manager.agent
      .post(
        `/api/batches/${batch.id}/devices/${device.id}/parts/${attachment.attachment.id}/swap`
      )
      .send({ destination: "available", note: "wrong box", serial: theirs });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain("same-SKU");

    // Nothing changed: the attachment is still the original unit.
    expect(partStatus(harness.db, mine)).toBe("reserved");
    expect(partStatus(harness.db, theirs)).toBe("available");
  });

  it("refuses an unknown serial (404) and a replacement that is not Available (409)", async () => {
    const sku = await createSku(manager.agent);
    const [only] = await intakeParts(manager.agent, sku.id, 1);
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");
    const attachment = await addPartBySku(manager.agent, batch.id, device.id, sku.id);

    const unknown = await manager.agent
      .post(
        `/api/batches/${batch.id}/devices/${device.id}/parts/${attachment.attachment.id}/swap`
      )
      .send({ destination: "available", note: "typo", serial: "P999999" });
    expect(unknown.status).toBe(404);

    // Scanning the ATTACHED unit itself: it is Reserved, not Available.
    const self = await manager.agent
      .post(
        `/api/batches/${batch.id}/devices/${device.id}/parts/${attachment.attachment.id}/swap`
      )
      .send({ destination: "available", note: "scanning the part already on the device", serial: only });
    expect(self.status).toBe(409);
    expect((self.body as { error: string }).error).toContain("not Available");

    // Still exactly one attachment, still the same part.
    const parts = await deviceParts(manager.agent, batch.id, device.id);
    expect(parts).toHaveLength(1);
    expect(parts[0].part.serial).toBe(only);
  });
});
