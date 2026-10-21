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
 * Ticket 05: parts on batches. Everything drives the HTTP API seam with a
 * throwaway SQLite file, per the project's single-test-seam decision. Setup
 * helpers create SKUs, stock, batches, and devices through the real endpoints.
 */

const SCREEN = { name: "iPhone 13 Screen", price: "109.99", kind: "serialized" };
const ADHESIVE = { name: "Adhesive strips", price: "1.50", kind: "consumable" };

interface SkuJson {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  priceCents: number;
}

interface PartJson {
  id: number;
  serial: string;
  status: string;
  statusLabel: string;
}

interface AttachmentJson {
  id: number;
  device: { id: number };
  part: PartJson;
  sku: SkuJson & { price: string };
  priceCents: number;
  price: string;
  addedAt: string;
  addedBy: { id: number; email: string };
  removedAt: string | null;
  removedTo: string | null;
  removalNote: string | null;
  removalReason: string | null;
}

interface PartAttachmentJson {
  id: number;
  batch: { id: number; number: number };
  device: { id: number; model: string };
  priceCents: number;
  price: string;
  addedAt: string;
  addedBy: { id: number; email: string };
  removedAt: string | null;
  removedTo: string | null;
  removalNote: string | null;
  removalReason: string | null;
}

interface DevicePartsJson {
  deviceId: number;
  parts: AttachmentJson[];
  consumables: Array<{
    id: number;
    sku: SkuJson;
    quantity: number;
    unitPriceCents: number;
    costCents: number;
  }>;
  demand: DemandJson[];
  partsCostCents: number;
  partsCost: string;
  // Ticket 06: the open demand's SKU-price estimate — display-only, excluded
  // from partsCostCents.
  openDemandEstimateCents: number;
  openDemandEstimate: string | null;
}

interface DemandJson {
  id: number;
  sku: SkuJson;
  batch: { id: number; number: number };
  device: { id: number } | null;
  supplier: string | null;
  status: string;
  createdAt: string;
  createdBy: { id: number; email: string };
}

async function createSku(
  agent: Agent,
  overrides: Record<string, unknown> = {},
): Promise<SkuJson> {
  const response = await agent.post("/api/skus").send({ ...SCREEN, ...overrides });
  expect(response.status).toBe(201);
  return response.body as SkuJson;
}

/** Intakes `count` Available units of a serialized SKU; returns their serials. */
async function intakeParts(agent: Agent, skuId: number, count: number): Promise<string[]> {
  const response = await agent.post(`/api/skus/${skuId}/parts`).send({ source: "migration", quantity: count, counted: false });
  expect(response.status).toBe(201);
  return (response.body.parts as PartJson[]).map((part) => part.serial);
}

async function createBatch(agent: Agent, note = "Batch opened for triage") {
  const response = await agent.post("/api/batches").send({ note });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function addDevice(agent: Agent, batchId: number, overrides: Record<string, unknown> = {}) {
  const response = await agent
    .post(`/api/batches/${batchId}/devices`)
    .send({ modelName: "iPhone 13", statedIssue: "Cracked screen", imei: "359175920074058", ...overrides });
  expect(response.status).toBe(201);
  return response.body as { id: number };
}

async function decideApproved(manager: Agent, batchId: number, deviceId: number) {
  const response = await manager
    .post(`/api/batches/${batchId}/devices/${deviceId}/approval`)
    .send({ decision: "approved" });
  expect(response.status).toBe(200);
}

async function approveBatch(manager: Agent, batchId: number) {
  return manager.post(`/api/batches/${batchId}/approve`).send({ note: "Costs look right" });
}

async function addPart(
  agent: Agent,
  batchId: number,
  deviceId: number,
  body: Record<string, unknown>,
) {
  return agent.post(`/api/batches/${batchId}/devices/${deviceId}/parts`).send(body);
}

async function deviceParts(
  agent: Agent,
  batchId: number,
  deviceId: number,
): Promise<DevicePartsJson | undefined> {
  const response = await agent.get(`/api/batches/${batchId}/parts`);
  expect(response.status).toBe(200);
  const devices = (response.body as { devices: DevicePartsJson[] }).devices;
  return devices.find((entry) => entry.deviceId === deviceId);
}

async function batchDetail(agent: Agent, batchId: number): Promise<BatchJson> {
  const response = await agent.get(`/api/batches/${batchId}`);
  expect(response.status).toBe(200);
  return response.body as BatchJson;
}

interface BatchJson {
  id: number;
  number: number;
  status: string;
  approvedCostCents: number | null;
}

function partStatus(harness: TestHarness, serial: string): string {
  const row = harness.db
    .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
    .get(serial) as { status: string };
  return row?.status;
}

describe("POST /api/batches/:batchId/devices/:deviceId/parts — reservation", () => {
  let harness: TestHarness;
  beforeEach(() => (harness = createTestHarness()));
  afterEach(() => harness.close());

  it("requires a session", async () => {
    const response = await harness.request.post("/api/batches/1/devices/1/parts").send({ skuId: 1 });
    expect(response.status).toBe(401);
  });

  it("reserves the oldest Available unit of the SKU transactionally and prices the device", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    const serials = await intakeParts(tech.agent, sku.id, 3); // P00001, P00002, P00003
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });

    const response = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });

    expect(response.status).toBe(201);
    expect(response.body.outcome).toBe("reserved");
    const attachment = response.body.attachment as AttachmentJson;
    // Oldest-first: the unit intake-ordered first is the unit pulled.
    expect(attachment.part.serial).toBe(serials[0]);
    expect(attachment.part.status).toBe("reserved");
    expect(attachment.part.statusLabel).toBe("Reserved");
    expect(attachment.sku.id).toBe(sku.id);
    expect(attachment.priceCents).toBe(10999);
    expect(attachment.addedBy.email).toBe("tech@acme.co");
    expect(attachment.removedAt).toBeNull();

    // The reservation is one transaction: part status + attachment row + events.
    expect(partStatus(harness, serials[0])).toBe("reserved");
    expect(partStatus(harness, serials[1])).toBe("available");
    const attachmentRow = harness.db
      .prepare("SELECT device_id, part_id, price_cents, removed_at FROM device_parts WHERE id = ?")
      .get(attachment.id) as { device_id: number; part_id: number; price_cents: number; removed_at: string | null };
    expect(attachmentRow).toEqual({ device_id: device.id, part_id: 1, price_cents: 10999, removed_at: null });

    // Reservation is an event on the part's own timeline...
    const partEvent = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE entity_type = 'part' AND entity_id = ? AND action = 'part.reserved'")
      .get(1) as { actor_id: number; action: string; payload: string };
    expect(partEvent.actor_id).toBe(tech.user.id);
    expect(JSON.parse(partEvent.payload)).toMatchObject({
      batchId: batch.id,
      deviceId: device.id,
      sku: "iPhone 13 Screen",
      serial: serials[0],
    });
    // ...and on the device's (hence the batch's) timeline.
    const deviceEvents = harness.db
      .prepare("SELECT action FROM events WHERE entity_type = 'device' AND entity_id = ? ORDER BY id")
      .all(device.id) as Array<{ action: string }>;
    expect(deviceEvents.map((event) => event.action)).toContain("device.part_reserved");

    // Parts Cost is computed from the attachment, not hand-entered.
    const listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing?.partsCostCents).toBe(10999);
    expect(listing?.partsCost).toBe("109.99");
  });

  it("adds a part by scanned serial alone (no SKU pick) — the serial resolves the unit and its SKU", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    const serials = await intakeParts(tech.agent, sku.id, 2); // P00001, P00002
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });

    // The scan path: the serial is the whole request — the server resolves
    // the unit and its SKU from the serial (the API contract the scan form
    // relies on: skuId and serial are mutually exclusive, either alone works).
    const response = await addPart(tech.agent, batch.id, device.id, { serial: serials[1] });

    expect(response.status).toBe(201);
    expect(response.body.outcome).toBe("reserved");
    const attachment = response.body.attachment as AttachmentJson;
    expect(attachment.part.serial).toBe(serials[1]);
    expect(attachment.part.status).toBe("reserved");
    expect(attachment.sku.id).toBe(sku.id);
    expect(attachment.priceCents).toBe(10999);
    expect(partStatus(harness, serials[1])).toBe("reserved");
    expect(partStatus(harness, serials[0])).toBe("available");
  });

  it("two adds racing for one unit: only the first reserves it; the second creates demand", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    await intakeParts(tech.agent, sku.id, 1); // exactly one Available unit
    const batch = await createBatch(tech.agent);
    const deviceA = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const deviceB = await addDevice(tech.agent, batch.id, { imei: "222222222222222" });

    // better-sqlite3 is one synchronous connection: these two API calls are
    // serialized by Node itself, and the reserve+attach write is wrapped in a
    // single transaction with a guarded status UPDATE — so a second racing
    // reservation of the same unit is structurally impossible.
    const first = await addPart(tech.agent, batch.id, deviceA.id, { skuId: sku.id });
    const second = await addPart(tech.agent, batch.id, deviceB.id, { skuId: sku.id });

    expect(first.status).toBe(201);
    expect(first.body.outcome).toBe("reserved");
    expect(second.status).toBe(201);
    expect(second.body.outcome).toBe("need_to_order");

    // The unit is reserved exactly once — for device A.
    expect(partStatus(harness, "P00001")).toBe("reserved");
    const attachments = harness.db
      .prepare("SELECT device_id FROM device_parts WHERE removed_at IS NULL")
      .all() as Array<{ device_id: number }>;
    expect(attachments).toEqual([{ device_id: deviceA.id }]);
    // Device B got a Need to Order demand record instead.
    expect(second.body.demand).toMatchObject({
      sku: { id: sku.id },
      batch: { id: batch.id },
      device: { id: deviceB.id },
      status: "open",
    });
  });

  it("rejects an unknown SKU, an unknown batch/device, and a consumable SKU", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    await intakeParts(tech.agent, sku.id, 1);
    const adhesive = await createSku(tech.agent, ADHESIVE);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });

    expect((await addPart(tech.agent, batch.id, device.id, { skuId: 9999 })).status).toBe(404);
    expect((await addPart(tech.agent, 9999, device.id, { skuId: sku.id })).status).toBe(404);
    expect((await addPart(tech.agent, batch.id, 9999, { skuId: sku.id })).status).toBe(404);
    const consumable = await addPart(tech.agent, batch.id, device.id, { skuId: adhesive.id });
    expect(consumable.status).toBe(400);
    expect(consumable.body.error).toContain("consumable");
  });

  it("refuses part changes on a terminal device", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    await intakeParts(tech.agent, sku.id, 1);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    // Repair proceeds only after a manager's approval (ticket 06) — the tech
    // cannot approve, so the manager signs off here. Ticket 25: the manager
    // first decides the device (approved).
    const manager = await harness.loginAs(MANAGER);
    expect(
      (
        await manager.agent
          .post(`/api/batches/${batch.id}/devices/${device.id}/approval`)
          .send({ decision: "approved" })
      ).status
    ).toBe(200);
    expect(
      (await manager.agent.post(`/api/batches/${batch.id}/approve`).send({ note: "ok" })).status
    ).toBe(200);
    const progressed = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/status`)
      .send({ repairStatus: "In progress" });
    expect(progressed.status).toBe(200);
    const repaired = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/status`)
      .send({ repairStatus: "Repaired", resolutionNotes: "done" });
    expect(repaired.status).toBe(200);

    const response = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("terminal");
  });
});

describe("Need to Order demand", () => {
  let harness: TestHarness;
  beforeEach(() => (harness = createTestHarness()));
  afterEach(() => harness.close());

  it("creates a demand record when Available stock is short, with an optional supplier link", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    // No stock at all.
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });

    const response = await addPart(tech.agent, batch.id, device.id, {
      skuId: sku.id,
      supplier: "MobileSentrix",
    });

    expect(response.status).toBe(201);
    expect(response.body.outcome).toBe("need_to_order");
    expect(response.body.demand).toMatchObject({
      sku: { id: sku.id, name: "iPhone 13 Screen" },
      batch: { id: batch.id, number: batch.number },
      device: { id: device.id },
      supplier: "MobileSentrix",
      status: "open",
      createdBy: { email: "tech@acme.co" },
    });
    expect(response.body.attachment).toBeUndefined();

    const row = harness.db
      .prepare("SELECT sku_id, batch_id, device_id, supplier, status FROM demand_records")
      .get() as { sku_id: number; batch_id: number; device_id: number; supplier: string; status: string };
    expect(row).toEqual({
      sku_id: sku.id,
      batch_id: batch.id,
      device_id: device.id,
      supplier: "MobileSentrix",
      status: "open",
    });
    // The demand record has its own timeline event.
    const event = harness.db
      .prepare("SELECT action, payload FROM events WHERE entity_type = 'demand'")
      .get() as { action: string; payload: string };
    expect(event.action).toBe("demand.created");
    expect(JSON.parse(event.payload)).toMatchObject({ skuId: sku.id, batchId: batch.id });
  });

  it("supplier is optional", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });

    const response = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    expect(response.body.demand.supplier).toBeNull();
  });

  it("auto-sets the device to Parts needed (from any active status)", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });

    await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });

    const statusRow = harness.db
      .prepare("SELECT repair_status FROM devices WHERE id = ?")
      .get(device.id) as { repair_status: string };
    expect(statusRow.repair_status).toBe("Parts needed");
    const statusEvent = harness.db
      .prepare("SELECT action, payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.status_changed'")
      .get(device.id) as { payload: string };
    expect(JSON.parse(statusEvent.payload)).toMatchObject({ from: "Awaiting repair", to: "Parts needed" });
  });

  it("is listable per batch and globally outstanding", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const manager = await harness.loginAs(DEFAULT_MANAGER_EMAIL);
    const screen = await createSku(tech.agent);
    const battery = await createSku(tech.agent, { name: "iPhone 13 Battery", price: "30.00" });
    const batchOne = await createBatch(tech.agent);
    const deviceOne = await addDevice(tech.agent, batchOne.id, { imei: "111111111111111" });
    const batchTwo = await createBatch(tech.agent, "Second batch");
    const deviceTwo = await addDevice(tech.agent, batchTwo.id, { imei: "222222222222222" });

    await addPart(tech.agent, batchOne.id, deviceOne.id, { skuId: screen.id });
    await addPart(tech.agent, batchTwo.id, deviceTwo.id, { skuId: battery.id, supplier: "Injured Gadgets" });

    const perBatch = await tech.agent.get(`/api/batches/${batchOne.id}/demand`);
    expect(perBatch.status).toBe(200);
    expect(perBatch.body.demand).toHaveLength(1);
    expect(perBatch.body.demand[0]).toMatchObject({
      sku: { id: screen.id },
      batch: { id: batchOne.id },
      status: "open",
    });

    // The GLOBAL queue is OUTSTANDING demand (ticket 09, spec decision 9:
    // open + on an Open batch + not already on a PO). A pre-approval batch's
    // demand is an estimate — it shows per batch but is not orderable/
    // outstanding until the manager signs the cost off.
    const beforeApproval = await tech.agent.get("/api/demand");
    expect(beforeApproval.status).toBe(200);
    expect(beforeApproval.body.demand).toHaveLength(0);

    await decideApproved(manager.agent, batchOne.id, deviceOne.id);
    await decideApproved(manager.agent, batchTwo.id, deviceTwo.id);
    expect((await approveBatch(manager.agent, batchOne.id)).status).toBe(200);
    expect((await approveBatch(manager.agent, batchTwo.id)).status).toBe(200);

    const global = await tech.agent.get("/api/demand");
    expect(global.status).toBe(200);
    expect(global.body.demand).toHaveLength(2);
    expect(global.body.demand.map((d: DemandJson) => d.sku.id).sort()).toEqual(
      [screen.id, battery.id].sort(),
    );
    // Globally listable = outstanding demand: a fulfilled record is not listed.
    harness.db
      .prepare("UPDATE demand_records SET status = 'fulfilled', fulfilled_at = '2026-09-24T12:00:00.000Z', fulfilled_by = ? WHERE sku_id = ?")
      .run(tech.user.id, screen.id);
    const afterFulfil = await tech.agent.get("/api/demand");
    expect(afterFulfil.body.demand).toHaveLength(1);
    expect(afterFulfil.body.demand[0].sku.id).toBe(battery.id);
  });
});

describe("consumable usage and computed Parts Cost", () => {
  let harness: TestHarness;
  beforeEach(() => (harness = createTestHarness()));
  afterEach(() => harness.close());

  it("records consumable quantity per device and rolls cost into Parts Cost", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const adhesive = await createSku(tech.agent, ADHESIVE);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });

    const response = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/consumables`)
      .send({ skuId: adhesive.id, quantity: 4, note: "screen reseal" });

    expect(response.status).toBe(201);
    expect(response.body.usage).toMatchObject({
      sku: { id: adhesive.id },
      quantity: 4,
      unitPriceCents: 150,
      costCents: 600,
    });

    const listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing?.partsCostCents).toBe(600);
    expect(listing?.partsCost).toBe("6.00");
    expect(listing?.consumables).toHaveLength(1);

    const event = harness.db
      .prepare("SELECT action, payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.consumable_used'")
      .get(device.id) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ skuId: adhesive.id, quantity: 4, unitPriceCents: 150 });
  });

  it("sums serialized snapshots and consumable usage into one computed cost, stable against later price changes", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const screen = await createSku(tech.agent);
    const adhesive = await createSku(tech.agent, ADHESIVE);
    await intakeParts(tech.agent, screen.id, 1);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });

    await addPart(tech.agent, batch.id, device.id, { skuId: screen.id });
    await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/consumables`)
      .send({ skuId: adhesive.id, quantity: 2 });

    let listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing?.partsCostCents).toBe(10999 + 300);
    expect(listing?.partsCost).toBe("112.99");

    // Prices drift after the fact — the device's cost does not.
    await tech.agent.patch(`/api/skus/${screen.id}`).send({ price: "199.00" });
    await tech.agent.patch(`/api/skus/${adhesive.id}`).send({ price: "3.00" });
    listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing?.partsCostCents).toBe(10999 + 300);
  });

  it("rejects serialized SKUs, non-positive quantities, and unknown SKUs", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const screen = await createSku(tech.agent);
    const adhesive = await createSku(tech.agent, ADHESIVE);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });

    const serialized = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/consumables`)
      .send({ skuId: screen.id, quantity: 1 });
    expect(serialized.status).toBe(400);
    expect(serialized.body.error).toContain("serialized");

    for (const quantity of [0, -1, 1.5]) {
      const invalid = await tech.agent
        .post(`/api/batches/${batch.id}/devices/${device.id}/consumables`)
        .send({ skuId: adhesive.id, quantity });
      expect(invalid.status).toBe(400);
    }
    expect(
      (
        await tech.agent
          .post(`/api/batches/${batch.id}/devices/${device.id}/consumables`)
          .send({ skuId: 9999, quantity: 1 })
      ).status,
    ).toBe(404);
  });
});

describe("removing consumable usage", () => {
  let harness: TestHarness;
  beforeEach(() => (harness = createTestHarness()));
  afterEach(() => harness.close());

  async function setupUsage(quantity = 4) {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const adhesive = await createSku(tech.agent, ADHESIVE);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const recorded = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/consumables`)
      .send({ skuId: adhesive.id, quantity, note: "screen reseal" });
    expect(recorded.status).toBe(201);
    return {
      tech,
      manager: await harness.loginAs(MANAGER),
      adhesive,
      batch,
      device,
      usageId: (recorded.body as { usage: { id: number } }).usage.id,
    };
  }

  function remove(tech: LoggedInAgent["agent"], setup: Awaited<ReturnType<typeof setupUsage>>, body: Record<string, unknown>) {
    return tech.post(`/api/batches/${setup.batch.id}/devices/${setup.device.id}/consumables/${setup.usageId}/remove`).send(body);
  }

  it("a tech removes usage with a required note — the cost drops, the row is KEPT, the timeline records it", async () => {
    const setup = await setupUsage();

    // The note is required — a cost never leaves a device silently.
    const noteless = await remove(setup.tech.agent, setup, {});
    expect(noteless.status).toBe(400);
    expect((noteless.body as { error: string }).error).toContain("a note is required");

    const removed = await remove(setup.tech.agent, setup, { note: "recorded on the wrong device" });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({
      removed: { usageId: setup.usageId, sku: "Adhesive strips", quantity: 4 },
      partsCostCents: 0,
      partsCost: "0.00",
    });

    // The listing shows only ACTIVE usage...
    const listing = await deviceParts(setup.tech.agent, setup.batch.id, setup.device.id);
    expect(listing?.consumables).toHaveLength(0);
    expect(listing?.partsCostCents).toBe(0);

    // ...but the ROW is kept, soft-removed with the full correction record.
    const row = harness.db
      .prepare(
        "SELECT removed_at, removed_by, removal_note FROM device_consumables WHERE id = ?"
      )
      .get(setup.usageId) as { removed_at: string | null; removed_by: number; removal_note: string };
    expect(row.removed_at).not.toBeNull();
    expect(row.removed_by).toBeDefined();
    expect(row.removal_note).toBe("recorded on the wrong device");

    // Both events are on the device's timeline: the usage and its removal.
    const events = harness.db
      .prepare(
        "SELECT action, payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action LIKE 'device.consumable%' ORDER BY id"
      )
      .all(setup.device.id) as Array<{ action: string; payload: string }>;
    expect(events.map((event) => event.action)).toEqual([
      "device.consumable_used",
      "device.consumable_removed",
    ]);
    expect(JSON.parse(events[1].payload)).toMatchObject({
      usageId: setup.usageId,
      quantity: 4,
      costCents: 600,
      note: "recorded on the wrong device",
    });
  });

  it("on an OPEN batch a tech removes usage post-approval and the approval is amended by the tech (ticket 02)", async () => {
    const setup = await setupUsage();
    // Approve: every device decided, then the manager's sign-off. The
    // approved cost includes the 4 × 1.50 usage.
    const detail0 = await setup.manager.agent.get(`/api/batches/${setup.batch.id}`);
    for (const device of (detail0.body as { devices: Array<{ id: number }> }).devices) {
      await setup.manager.agent
        .post(`/api/batches/${setup.batch.id}/devices/${device.id}/approval`)
        .send({ decision: "approved" });
    }
    expect(
      (await setup.manager.agent.post(`/api/batches/${setup.batch.id}/approve`).send({ note: "ok" }))
        .status,
    ).toBe(200);
    expect(
      (await batchDetail(setup.manager.agent, setup.batch.id)).approvedCostCents,
    ).toBe(600);

    // Ticket 02: a usage removal is a cost correction that only ever
    // reduces cost — the tech removes post-approval with the required note,
    // and the standing approval is amended in place by the tech's actor.
    const techRemoved = await remove(setup.tech.agent, setup, {
      note: "usage recorded on the wrong device",
    });
    expect(techRemoved.status).toBe(200);
    const detail = await batchDetail(setup.manager.agent, setup.batch.id);
    expect(detail.approvedCostCents).toBe(0);

    const amended = harness.db
      .prepare(
        "SELECT actor_id, payload FROM events WHERE entity_type = 'batch' AND entity_id = ? AND action = 'batch.approval_amended' ORDER BY id DESC LIMIT 1"
      )
      .get(setup.batch.id) as { actor_id: number; payload: string };
    expect(amended.actor_id).toBe(setup.tech.user.id);
    expect(JSON.parse(amended.payload)).toMatchObject({
      previousTotalCents: 600,
      totalCents: 0,
      note: "usage recorded on the wrong device",
    });
  });

  it("an unknown usage id, another device's usage, and a double removal are refused loudly", async () => {
    const setup = await setupUsage();
    const other = await addDevice(setup.tech.agent, setup.batch.id, { imei: "222222222222222" });
    const otherDeviceId = other.id;

    const unknown = await setup.tech.agent
      .post(`/api/batches/${setup.batch.id}/devices/${setup.device.id}/consumables/9999/remove`)
      .send({ note: "no such usage" });
    expect(unknown.status).toBe(404);

    // The usage exists but belongs to another device: 404, not a removal.
    const wrongDevice = await setup.tech.agent
      .post(`/api/batches/${setup.batch.id}/devices/${otherDeviceId}/consumables/${setup.usageId}/remove`)
      .send({ note: "not mine" });
    expect(wrongDevice.status).toBe(404);

    expect(
      (await remove(setup.tech.agent, setup, { note: "first removal" })).status,
    ).toBe(200);
    const again = await remove(setup.tech.agent, setup, { note: "second removal" });
    expect(again.status).toBe(409);
    expect((again.body as { error: string }).error).toContain("already removed");
  });
});

describe("same-SKU swap", () => {
  let harness: TestHarness;
  beforeEach(() => (harness = createTestHarness()));
  afterEach(() => harness.close());

  it("replaces the reserved unit with the next Available unit and routes the old one to a destination", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    const [oldSerial, newSerial] = await intakeParts(tech.agent, sku.id, 2);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    const attachmentId = (added.body.attachment as AttachmentJson).id;

    const response = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/parts/${attachmentId}/swap`)
      .send({ destination: "rma", note: "screen was DOA, sending back" });

    expect(response.status).toBe(201);
    expect(response.body.outcome).toBe("swapped");
    expect(response.body.attachment.part.serial).toBe(newSerial);
    expect(response.body.attachment.part.status).toBe("reserved");
    expect(response.body.oldPart.serial).toBe(oldSerial);
    expect(response.body.oldPart.status).toBe("rma");

    expect(partStatus(harness, oldSerial)).toBe("rma");
    expect(partStatus(harness, newSerial)).toBe("reserved");
    // The old attachment is closed out with destination + note + reason...
    const oldRow = harness.db
      .prepare("SELECT removed_to, removal_note, removal_reason, removed_at FROM device_parts WHERE part_id = (SELECT id FROM serialized_parts WHERE serial = ?)")
      .get(oldSerial) as { removed_to: string; removal_note: string; removal_reason: string; removed_at: string };
    expect(oldRow.removed_to).toBe("rma");
    expect(oldRow.removal_note).toBe("screen was DOA, sending back");
    expect(oldRow.removal_reason).toBe("swap");
    expect(oldRow.removed_at).toBe(harness.clock.now().toISOString());
    // ...and exactly one active attachment remains, holding the new unit.
    const active = harness.db
      .prepare("SELECT COUNT(*) AS n FROM device_parts WHERE device_id = ? AND removed_at IS NULL")
      .get(device.id) as { n: number };
    expect(active.n).toBe(1);

    // Both parts' timelines carry the swap: removal on the old, reservation on the new.
    const oldEvent = harness.db
      .prepare("SELECT action, payload FROM events WHERE entity_type = 'part' AND entity_id = (SELECT id FROM serialized_parts WHERE serial = ?) AND action = 'part.removed'")
      .get(oldSerial) as { payload: string };
    expect(JSON.parse(oldEvent.payload)).toMatchObject({
      to: "rma",
      reason: "swap",
      note: "screen was DOA, sending back",
      swappedWith: newSerial,
    });
    const newEvent = harness.db
      .prepare("SELECT action, payload FROM events WHERE entity_type = 'part' AND entity_id = (SELECT id FROM serialized_parts WHERE serial = ?) AND action = 'part.reserved'")
      .get(newSerial) as { payload: string };
    expect(JSON.parse(newEvent.payload)).toMatchObject({ swappedFor: oldSerial });

    // Cost follows the replacement (snapshot at swap time).
    const listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing?.partsCostCents).toBe(10999);
  });

  it("attributes Damaged by Tech to the acting tech", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    const [oldSerial, newSerial] = await intakeParts(tech.agent, sku.id, 2);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    const attachmentId = (added.body.attachment as AttachmentJson).id;

    const response = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/parts/${attachmentId}/swap`)
      .send({ destination: "damaged_by_tech", note: "cracked it during install" });

    expect(response.status).toBe(201);
    expect(partStatus(harness, oldSerial)).toBe("damaged_by_tech");
    expect(partStatus(harness, newSerial)).toBe("reserved");
    const event = harness.db
      .prepare("SELECT actor_id, payload FROM events WHERE entity_type = 'part' AND entity_id = (SELECT id FROM serialized_parts WHERE serial = ?) AND action = 'part.removed'")
      .get(oldSerial) as { actor_id: number; payload: string };
    // The acting tech is the event's actor — that is the attribution.
    expect(event.actor_id).toBe(tech.user.id);
    expect(JSON.parse(event.payload)).toMatchObject({ to: "damaged_by_tech", attribution: "tech@acme.co" });
  });

  it("requires a destination and a note", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    await intakeParts(tech.agent, sku.id, 2);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    const attachmentId = (added.body.attachment as AttachmentJson).id;
    const url = `/api/batches/${batch.id}/devices/${device.id}/parts/${attachmentId}/swap`;

    expect((await tech.agent.post(url).send({ destination: "rma" })).status).toBe(400);
    expect((await tech.agent.post(url).send({ note: "why" })).status).toBe(400);
    expect((await tech.agent.post(url).send({ destination: "unavailable", note: "hmm" })).status).toBe(400);
    expect(partStatus(harness, "P00001")).toBe("reserved"); // nothing changed
  });

  it("refuses a swap with no Available unit of the SKU and leaves everything untouched", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    await intakeParts(tech.agent, sku.id, 1);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    const attachmentId = (added.body.attachment as AttachmentJson).id;

    const response = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/parts/${attachmentId}/swap`)
      .send({ destination: "available", note: "just swapping" });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("Available");
    expect(partStatus(harness, "P00001")).toBe("reserved");
    const active = harness.db
      .prepare("SELECT COUNT(*) AS n FROM device_parts WHERE device_id = ? AND removed_at IS NULL")
      .get(device.id) as { n: number };
    expect(active.n).toBe(1);
  });
});

describe("removal", () => {
  let harness: TestHarness;
  beforeEach(() => (harness = createTestHarness()));
  afterEach(() => harness.close());

  it("requires a destination and a note — never a silent return to stock", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    const serial = (await intakeParts(tech.agent, sku.id, 1))[0];
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    const attachmentId = (added.body.attachment as AttachmentJson).id;
    const url = `/api/batches/${batch.id}/devices/${device.id}/parts/${attachmentId}/remove`;

    expect((await tech.agent.post(url).send({})).status).toBe(400);
    expect((await tech.agent.post(url).send({ destination: "available" })).status).toBe(400);
    expect((await tech.agent.post(url).send({ note: "why" })).status).toBe(400);
    expect((await tech.agent.post(url).send({ destination: "somewhere", note: "why" })).status).toBe(400);
    expect(partStatus(harness, serial)).toBe("reserved");

    const response = await tech.agent.post(url).send({ destination: "available", note: "pulled the wrong unit" });
    expect(response.status).toBe(200);
    expect(partStatus(harness, serial)).toBe("available");
    expect(response.body.attachment.removedAt).not.toBeNull();
    expect(response.body.attachment.removedTo).toBe("available");
    expect(response.body.attachment.removalNote).toBe("pulled the wrong unit");
    expect(response.body.attachment.removalReason).toBe("removal");

    // The device's cost drops to zero once the only part is removed.
    const listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing?.partsCostCents).toBe(0);
  });

  it("records the acting tech for Damaged by Tech attribution", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    const serial = (await intakeParts(tech.agent, sku.id, 1))[0];
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    const attachmentId = (added.body.attachment as AttachmentJson).id;

    const response = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/parts/${attachmentId}/remove`)
      .send({ destination: "damaged_by_tech", note: "dropped it" });

    expect(response.status).toBe(200);
    expect(partStatus(harness, serial)).toBe("damaged_by_tech");
    const event = harness.db
      .prepare("SELECT actor_id, payload FROM events WHERE entity_type = 'part' AND entity_id = (SELECT id FROM serialized_parts WHERE serial = ?) AND action = 'part.removed'")
      .get(serial) as { actor_id: number; payload: string };
    expect(event.actor_id).toBe(tech.user.id);
    expect(JSON.parse(event.payload)).toMatchObject({ to: "damaged_by_tech", attribution: "tech@acme.co" });
  });

  it("404s an unknown attachment and 409s an already-removed one", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    await intakeParts(tech.agent, sku.id, 1);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
    const attachmentId = (added.body.attachment as AttachmentJson).id;

    expect(
      (
        await tech.agent
          .post(`/api/batches/${batch.id}/devices/${device.id}/parts/9999/remove`)
          .send({ destination: "available", note: "x" })
      ).status,
    ).toBe(404);

    await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/parts/${attachmentId}/remove`)
      .send({ destination: "available", note: "first removal" });
    const second = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/parts/${attachmentId}/remove`)
      .send({ destination: "rma", note: "again" });
    expect(second.status).toBe(409);
  });
});

describe("part history across batches", () => {
  let harness: TestHarness;
  beforeEach(() => (harness = createTestHarness()));
  afterEach(() => harness.close());

  it("shows every batch/device a part was attached to, including past attachments", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    const serial = (await intakeParts(tech.agent, sku.id, 1))[0];
    const batchOne = await createBatch(tech.agent, "first run");
    const deviceOne = await addDevice(tech.agent, batchOne.id, { imei: "111111111111111" });
    const batchTwo = await createBatch(tech.agent, "re-repair");
    const deviceTwo = await addDevice(tech.agent, batchTwo.id, { imei: "222222222222222" });

    // Attach, remove, re-attach on another batch's device.
    const added = await addPart(tech.agent, batchOne.id, deviceOne.id, { skuId: sku.id });
    const attachmentId = (added.body.attachment as AttachmentJson).id;
    await tech.agent
      .post(`/api/batches/${batchOne.id}/devices/${deviceOne.id}/parts/${attachmentId}/remove`)
      .send({ destination: "available", note: "customer cancelled" });
    await addPart(tech.agent, batchTwo.id, deviceTwo.id, { skuId: sku.id });

    const response = await tech.agent.get(`/api/parts/${serial}/attachments`);
    expect(response.status).toBe(200);
    const attachments = response.body.attachments as PartAttachmentJson[];
    expect(attachments).toHaveLength(2);
    expect(attachments[0].batch.id).toBe(batchOne.id);
    expect(attachments[0].removedAt).not.toBeNull();
    expect(attachments[0].removalReason).toBe("removal");
    expect(attachments[1].batch.id).toBe(batchTwo.id);
    expect(attachments[1].removedAt).toBeNull();

    // The part detail's events carry the whole story too.
    const detail = await tech.agent.get(`/api/parts/${serial}`);
    const actions = (detail.body.events as Array<{ action: string }>).map((event) => event.action);
    expect(actions).toEqual(["part.added", "part.reserved", "part.removed", "part.reserved"]);
  });

  it("keeps the bare part-status endpoint consistent: Reserved is owned by batches", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const sku = await createSku(tech.agent);
    const serial = (await intakeParts(tech.agent, sku.id, 1))[0];
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });

    // Cannot move a Reserved part away from Reserved here...
    const away = await tech.agent
      .post(`/api/parts/${serial}/status`)
      .send({ status: "available", note: "trying to release it here" });
    expect(away.status).toBe(409);
    // ...and cannot make anything Reserved through this endpoint either.
    const into = await tech.agent
      .post(`/api/parts/${serial}/status`)
      .send({ status: "reserved", note: "trying to reserve here" });
    expect(into.status).toBe(400);
    expect(partStatus(harness, serial)).toBe("reserved");
  });
});

describe("GET /api/batches/:batchId/parts", () => {
  let harness: TestHarness;
  beforeEach(() => (harness = createTestHarness()));
  afterEach(() => harness.close());

  it("returns every device's parts (including removed), consumables, demand, and computed cost", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const screen = await createSku(tech.agent);
    const battery = await createSku(tech.agent, { name: "Battery", price: "30.00" });
    const adhesive = await createSku(tech.agent, ADHESIVE);
    await intakeParts(tech.agent, screen.id, 2);
    const batch = await createBatch(tech.agent);
    const deviceA = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const deviceB = await addDevice(tech.agent, batch.id, { imei: "222222222222222" });

    await addPart(tech.agent, batch.id, deviceA.id, { skuId: screen.id });
    await addPart(tech.agent, batch.id, deviceA.id, { skuId: battery.id }); // short → demand
    await addPart(tech.agent, batch.id, deviceB.id, { skuId: screen.id });
    await tech.agent
      .post(`/api/batches/${batch.id}/devices/${deviceB.id}/consumables`)
      .send({ skuId: adhesive.id, quantity: 3 });

    const response = await tech.agent.get(`/api/batches/${batch.id}/parts`);
    expect(response.status).toBe(200);
    const devices = (response.body as { devices: DevicePartsJson[] }).devices;
    expect(devices.map((entry) => entry.deviceId).sort()).toEqual([deviceA.id, deviceB.id].sort());

    const entryA = devices.find((entry) => entry.deviceId === deviceA.id)!;
    expect(entryA.parts).toHaveLength(1);
    expect(entryA.parts[0].part.serial).toBe("P00001");
    expect(entryA.demand).toHaveLength(1);
    expect(entryA.demand[0].sku.id).toBe(battery.id);
    expect(entryA.partsCostCents).toBe(10999);
    // Ticket 06: the open demand rides along as its OWN estimate field,
    // priced at the SKU's current price — and it stays OUT of the stored
    // Parts Cost (a demand is an estimate, not a signed-off cost).
    expect(entryA.openDemandEstimateCents).toBe(3000);
    expect(entryA.openDemandEstimate).toBe("NTO — est. $30.00");

    const entryB = devices.find((entry) => entry.deviceId === deviceB.id)!;
    expect(entryB.parts[0].part.serial).toBe("P00002");
    expect(entryB.consumables[0].quantity).toBe(3);
    expect(entryB.partsCostCents).toBe(10999 + 450);
    expect(entryB.openDemandEstimateCents).toBe(0);
    expect(entryB.openDemandEstimate).toBeNull();
  });

  it("reports the NTO estimate only while the demand is open, and never in the cost sum", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const screen = await createSku(tech.agent);
    const battery = await createSku(tech.agent, { name: "Battery", price: "30.00" });
    await intakeParts(tech.agent, screen.id, 1);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "333333333333333" });

    // No stock → the battery add becomes a Need to Order demand.
    await addPart(tech.agent, batch.id, device.id, { skuId: battery.id });
    let listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing?.openDemandEstimateCents).toBe(3000);
    expect(listing?.openDemandEstimate).toBe("NTO — est. $30.00");
    // The estimate is display-only: the stored Parts Cost excludes it.
    expect(listing?.partsCostCents).toBe(0);

    // Once the demand is no longer open it is not even an estimate any more.
    const demandId = listing!.demand[0].id;
    const cancelled = await tech.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/demand/${demandId}/cancel`)
      .send({ note: "customer cancelled the repair" });
    expect(cancelled.status).toBe(200);
    listing = await deviceParts(tech.agent, batch.id, device.id);
    expect(listing?.openDemandEstimateCents).toBe(0);
    expect(listing?.openDemandEstimate).toBeNull();
    expect(listing?.partsCostCents).toBe(0);
  });

  it("404s an unknown batch", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    expect((await tech.agent.get("/api/batches/9999/parts")).status).toBe(404);
  });
});
