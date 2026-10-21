import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

interface SkuHit {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  price: string;
  priceCents: number;
}

interface PartHit {
  id: number;
  serial: string;
  status: string;
  statusLabel: string;
  skuId: number;
  skuName: string;
}

interface DeviceHit {
  id: number;
  batchId: number;
  batchNumber: number;
  model: string;
  imei: string | null;
  assetId: string | null;
  serialNumber: string | null;
  repairStatus: string;
  assignedTechId: number;
  assignedTechEmail: string;
}

interface BatchHit {
  id: number;
  number: number;
  createdAt: string;
  createdByEmail: string;
  deviceTotal: number;
}

interface OrderHit {
  id: number;
  number: number;
  status: string;
  createdAt: string;
  createdByEmail: string;
}

interface RmaHit extends OrderHit {
  statusLabel: string;
}

interface DirectHit {
  type: "part";
  id: number;
  serial: string;
  skuId: number;
}

interface SearchBody {
  query: string;
  userId: number | null;
  directHit: DirectHit | null;
  filterUsers: Array<{ id: number; email: string }>;
  results: {
    skus: SkuHit[];
    parts: PartHit[];
    devices: DeviceHit[];
    batches: BatchHit[];
    purchaseOrders: OrderHit[];
    rmaOrders: RmaHit[];
    buybackOrders: RmaHit[];
    returnOrders: RmaHit[];
  };
}

async function createSku(agent: Agent, name: string, kind: "serialized" | "consumable" = "serialized") {
  const response = await agent.post("/api/skus").send({ name, price: "109.99", kind });
  expect(response.status).toBe(201);
  return response.body as { id: number; name: string };
}

async function intakePart(agent: Agent, skuId: number) {
  const response = await agent.post(`/api/skus/${skuId}/parts`).send({ source: "migration", quantity: 1, counted: false });
  expect(response.status).toBe(201);
  return (response.body as { parts: Array<{ id: number; serial: string; status: string }> }).parts[0];
}

async function createBatch(agent: Agent, note = "opened for triage") {
  const response = await agent.post("/api/batches").send({ note });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function addDevice(agent: Agent, batchId: number, overrides: Record<string, unknown> = {}) {
  const response = await agent.post(`/api/batches/${batchId}/devices`).send({
    modelName: "iPhone 13",
    statedIssue: "Cracked screen",
    ...overrides,
  });
  expect(response.status).toBe(201);
  return response.body as { id: number; batchId: number };
}

async function createPo(agent: Agent, skuId: number, purpose = "restock screens") {
  const response = await agent.post("/api/purchase-orders").send({
    purpose,
    note: "weekly restock",
    lines: [{ skuId, quantity: 1, unitPrice: "109.99" }],
  });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function createRma(agent: Agent, note = "defective screens back to vendor") {
  const response = await agent.post("/api/rma-orders").send({ note });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function createReturn(agent: Agent, note = "overstock back to vendor") {
  const response = await agent.post("/api/return-orders").send({ note });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

/** The typed search call: every test reads the documented response shape. */
async function search(
  agent: Agent,
  q: string,
  userId?: number
): Promise<{ status: number; body: SearchBody }> {
  const path =
    userId === undefined
      ? `/api/search?q=${encodeURIComponent(q)}`
      : `/api/search?q=${encodeURIComponent(q)}&userId=${userId}`;
  return agent.get(path);
}

describe("GET /api/search", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("requires a session", async () => {
    const response = await harness.request.get("/api/search?q=anything");
    expect(response.status).toBe(401);
  });

  it("requires a non-empty query", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    for (const q of [undefined, "", "   "]) {
      const response = await agent.get(q === undefined ? "/api/search" : `/api/search?q=${encodeURIComponent(q)}`);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("query");
    }
  });

  it("rejects a malformed userId filter", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    for (const userId of ["abc", "0", "-1", "1.5"]) {
      const response = await agent.get(`/api/search?q=screen&userId=${userId}`);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("userId");
    }
  });

  it("rejects a userId filter naming no known user", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    const response = await agent.get("/api/search?q=screen&userId=999");
    expect(response.status).toBe(404);
  });

  it("returns every group — all empty — and no direct hit when nothing matches", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    const response = await agent.get("/api/search?q=nothing-matches-this");
    expect(response.status).toBe(200);
    const body = response.body as SearchBody;
    expect(body.query).toBe("nothing-matches-this");
    expect(body.userId).toBeNull();
    expect(body.directHit).toBeNull();
    expect(body.results).toEqual({
      skus: [],
      parts: [],
      devices: [],
      batches: [],
      purchaseOrders: [],
      rmaOrders: [],
      buybackOrders: [],
      returnOrders: [],
    });
  });

  it("matches SKU names as a case-insensitive substring, serialized and consumable alike", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    await createSku(agent, "iPhone 13 Screen");
    await createSku(agent, "iPhone 13 Battery");
    await createSku(agent, "Adhesive Screen Kit", "consumable");
    await createSku(agent, "Charging Port");

    const response = await search(agent, "SCREEN");
    expect(response.status).toBe(200);
    expect(response.body.results.skus.map((sku) => sku.name)).toEqual([
      "Adhesive Screen Kit",
      "iPhone 13 Screen",
    ]);
    expect(response.body.results.skus[0]).toMatchObject({ kind: "consumable", priceCents: 10999 });
  });

  it("treats % and _ in the query as literal characters, not wildcards", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    await createSku(agent, "LCD Assembly 100");

    const underscore = await search(agent, "1_0"); // an unescaped _ would match "100"
    expect(underscore.body.results.skus).toEqual([]);
    const percent = await search(agent, "10%"); // an unescaped % would match "10" + anything
    expect(percent.body.results.skus).toEqual([]);
  });

  it("matches a part by exact serial, case-insensitively, and reports the scan-first direct hit", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    const sku = await createSku(agent, "iPhone 13 Screen");
    await intakePart(agent, sku.id); // P00001
    const second = await intakePart(agent, sku.id); // P00002

    const exact = await search(agent, " P00002 ");
    expect(exact.body.results.parts.map((part) => part.serial)).toEqual(["P00002"]);
    expect(exact.body.results.parts[0]).toMatchObject({
      skuId: sku.id,
      skuName: "iPhone 13 Screen",
      status: "available",
      statusLabel: "Available",
    });
    expect(exact.body.directHit).toMatchObject({ type: "part", id: second.id, serial: "P00002", skuId: sku.id });

    const lower = await search(agent, "p00002");
    expect(lower.body.results.parts.map((part) => part.serial)).toEqual(["P00002"]);
    expect(lower.body.directHit).toMatchObject({ serial: "P00002" });

    // A serial never matches by substring: scans are exact.
    const partial = await search(agent, "P000");
    expect(partial.body.results.parts).toEqual([]);
    expect(partial.body.directHit).toBeNull();
  });

  it("matches device identifiers — IMEI, Asset ID, serial number — on every batch row, newest batch first", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    const first = await createBatch(agent);
    const second = await createBatch(agent);

    const onFirst = await addDevice(agent, first.id, { imei: "359175920074058" });
    const onSecond = await addDevice(agent, second.id, { imei: "359175920074058" }); // re-repair: duplicate IMEI warns, never blocks
    const byAsset = await addDevice(agent, first.id, { assetId: "A-77", imei: "111111111111111" });
    const bySerial = await addDevice(agent, first.id, {
      imei: "222222222222222",
      serialNumber: "SN-XYZ-9",
    });

    const imei = await search(agent, "359175920074058");
    expect(imei.body.results.devices.map((device) => [device.batchNumber, device.id])).toEqual([
      [second.number, onSecond.id],
      [first.number, onFirst.id],
    ]);
    expect(imei.body.results.devices[0]).toMatchObject({
      batchId: second.id,
      model: "iPhone 13",
      repairStatus: "Awaiting repair",
      assignedTechEmail: MANAGER,
    });

    const asset = await search(agent, "a-77");
    expect(asset.body.results.devices.map((device) => device.id)).toEqual([byAsset.id]);

    const serial = await search(agent, "sn-xyz-9");
    expect(serial.body.results.devices.map((device) => device.id)).toEqual([bySerial.id]);
  });

  it('a bare number ("2") finds batch #2 and any PO/RMA/return #2 — each number space on its own, "#" optional', async () => {
    const { agent } = await harness.loginAs(MANAGER);
    const sku = await createSku(agent, "iPhone 13 Screen");
    await createBatch(agent); // batch #1
    await createBatch(agent); // batch #2
    await createPo(agent, sku.id); // PO #1 — the only PO
    await createRma(agent); // RMA #1
    await createRma(agent); // RMA #2
    await createReturn(agent); // return #1
    await createReturn(agent); // return #2

    const bare = await search(agent, "2");
    expect(bare.body.results.batches.map((batch) => batch.number)).toEqual([2]);
    expect(bare.body.results.purchaseOrders).toEqual([]); // no PO #2 exists
    expect(bare.body.results.rmaOrders.map((order) => order.number)).toEqual([2]);
    expect(bare.body.results.returnOrders.map((order) => order.number)).toEqual([2]);
    expect(bare.body.results.returnOrders[0].statusLabel).toBe("In-Transit");

    const hash = await search(agent, "#2");
    expect(hash.body.results.batches.map((batch) => batch.number)).toEqual([2]);

    // A text query never falls into the number match.
    const text = await search(agent, "screen");
    expect(text.body.results.batches).toEqual([]);
    expect(text.body.results.rmaOrders).toEqual([]);
    expect(text.body.results.returnOrders).toEqual([]);
  });

  it("lists the users the filter can narrow by", async () => {
    const tech = await harness.createUserAs("tech@acme.com", "tech");
    const { agent } = await harness.loginAs(MANAGER);
    const response = await search(agent, "screen");
    expect(response.body.filterUsers).toEqual([
      { id: expect.any(Number), email: MANAGER },
      { id: tech.user.id, email: "tech@acme.com" },
    ]);
  });

  it("narrows batches/POs/RMA orders by creator and devices by Assigned Tech — never SKUs or parts", async () => {
    const manager = await harness.loginAs(MANAGER);
    const tech = await harness.createUserAs("tech@acme.com", "tech");
    const sku = await createSku(manager.agent, "iPhone 13 Screen");
    const part = await intakePart(manager.agent, sku.id);

    const batch1 = await createBatch(manager.agent); // manager's, #1
    await createBatch(tech.agent); // tech's, #2
    // Manager's batch, device deliberately assigned to the tech.
    const assigned = await addDevice(manager.agent, batch1.id, {
      imei: "111111111111111",
      assignedTechId: tech.user.id,
    });
    await createPo(manager.agent, sku.id); // PO #1, manager's
    await createRma(manager.agent); // RMA #1, manager's
    await createRma(tech.agent); // RMA #2, tech's

    const byManager = await search(manager.agent, "1", manager.user.id);
    expect(byManager.body.userId).toBe(manager.user.id);
    expect(byManager.body.results.batches.map((batch) => batch.number)).toEqual([1]);
    expect(byManager.body.results.purchaseOrders.map((po) => po.number)).toEqual([1]);
    expect(byManager.body.results.rmaOrders.map((order) => order.number)).toEqual([1]);

    const byTech = await search(manager.agent, "2", tech.user.id);
    expect(byTech.body.results.batches.map((batch) => batch.number)).toEqual([2]);
    expect(byTech.body.results.purchaseOrders).toEqual([]);
    expect(byTech.body.results.rmaOrders.map((order) => order.number)).toEqual([2]);

    // Devices narrow by Assigned Tech, not creator.
    const deviceAsManager = await search(manager.agent, "111111111111111", manager.user.id);
    expect(deviceAsManager.body.results.devices).toEqual([]);
    const deviceAsTech = await search(manager.agent, "111111111111111", tech.user.id);
    expect(deviceAsTech.body.results.devices.map((device) => device.id)).toEqual([assigned.id]);

    // The filter never applies to SKU names or part serials: they have no creator.
    const skuAsTech = await search(manager.agent, "screen", tech.user.id);
    expect(skuAsTech.body.results.skus.map((hit) => hit.id)).toEqual([sku.id]);
    const partAsTech = await search(manager.agent, part.serial, tech.user.id);
    expect(partAsTech.body.results.parts.map((hit) => hit.id)).toEqual([part.id]);
    expect(partAsTech.body.directHit).toMatchObject({ type: "part", serial: part.serial });
  });
});
