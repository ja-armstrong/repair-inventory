import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

/**
 * Ticket 07 — purchase orders: creation (purpose, lines, sources, shipping,
 * tracking), manager-only approval with a required note, appendable tracking,
 * sequential numbers, and the merged immutable timeline.
 *
 * Everything drives the HTTP seam, per the project's testing decisions.
 *
 * The Need to Order demand integration (ticket 05) is real: their
 * `demand_records` table (migration 0005) exists, so demand rows are seeded
 * directly against that shape (see `seedDemandRow` — their HTTP endpoints
 * were still landing in parallel, so the row insert is SQL while the batch
 * it hangs off comes through the real API).
 */

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

interface SkuJson {
  id: number;
  name: string;
  kind: string;
  price: string;
  priceCents: number;
}

interface LineJson {
  id: number;
  sku: { id: number; name: string };
  quantity: number;
  unitPrice: string;
  unitPriceCents: number;
  source: string | null;
  demand: { id: number; batchNumber: number; device: string | null } | null;
}

interface TrackingJson {
  id: number;
  carrier: string;
  trackingNumber: string;
  addedAt: string;
  addedBy: { id: number; email: string };
}

interface EventJson {
  id: number;
  at: string;
  actor: { id: number; email: string } | null;
  action: string;
  entityType: string;
  entityId: number;
  payload: Record<string, unknown> | null;
}

interface PoSummaryJson {
  id: number;
  number: number;
  purpose: string;
  sources: string | null;
  status: string;
  createdAt: string;
  createdBy: { id: number; email: string };
  lineCount: number;
  trackingCount: number;
  totalCents: number;
  total: string;
}

interface PoDetailJson extends PoSummaryJson {
  shippingCost: string;
  shippingCostCents: number;
  approvedAt: string | null;
  approvedBy: { id: number; email: string } | null;
  demandIds: number[];
  lines: LineJson[];
  tracking: TrackingJson[];
  expectedSerials: Array<{ id: number; serial: string; received: boolean }>;
  events: EventJson[];
}

async function createSku(agent: Agent, name: string, price = "12.34"): Promise<number> {
  const response = await agent.post("/api/skus").send({ name, price, kind: "serialized" });
  expect(response.status).toBe(201);
  return (response.body as SkuJson).id;
}

function poBody(skuIds: number[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    purpose: "Weekly screens restock",
    note: "Ordering for batch #3 devices",
    sources: "MobileSentrix",
    shippingCost: "9.99",
    lines: skuIds.map((skuId) => ({
      skuId,
      quantity: 2,
      unitPrice: "12.34",
      source: "MobileSentrix",
    })),
    tracking: [{ carrier: "UPS", trackingNumber: "1Z999AA10123456784" }],
    ...overrides,
  };
}

/**
 * Seeds one open Need to Order demand record (ticket 05's real shape).
 * The batch it is tied to comes through the real batches API; the demand
 * row itself is inserted with SQL because ticket 05's demand endpoints
 * were still mid-flight in parallel when this was written.
 */
async function seedDemandRow(
  harness: TestHarness,
  tech: LoggedInAgent,
  skuId: number,
  supplier: string | null
): Promise<number> {
  const batch = await tech.agent.post("/api/batches").send({ note: "device blocked on parts" });
  expect(batch.status).toBe(201);
  // Demand is orderable only from an APPROVED (Open) batch — approve it (an
  // empty batch approves vacuously), as the manager would at sign-off.
  const manager = await harness.loginAs(DEFAULT_MANAGER_EMAIL);
  const approved = await manager.agent
    .post(`/api/batches/${batch.body.id}/approve`)
    .send({ note: "costs approved" });
  expect(approved.status).toBe(200);
  const result = harness.db
    .prepare(
      `INSERT INTO demand_records (sku_id, batch_id, device_id, supplier, status, created_at, created_by)
       VALUES (?, ?, NULL, ?, 'open', ?, ?)`
    )
    .run(skuId, batch.body.id, supplier, harness.clock.now().toISOString(), tech.user.id);
  return Number(result.lastInsertRowid);
}

interface BatchJson {
  id: number;
  number: number;
}

interface DeviceJson {
  id: number;
}

/**
 * Seeds one open Need to Order demand record tied to a REAL device
 * (ticket 04's "Fulfills demand" label reads the device join). The batch
 * comes through the real API: created, given its device while still
 * Awaiting approval, the device approved (a batch with undecided devices
 * cannot be approved), then the batch approved — demand is orderable only
 * from an Open batch. The demand row itself is SQL, like `seedDemandRow`.
 */
async function seedDeviceDemand(
  harness: TestHarness,
  tech: LoggedInAgent,
  skuId: number,
  identifiers: { imei?: string; assetId?: string; serialNumber?: string }
): Promise<{ demandId: number; batchNumber: number }> {
  const batch = await tech.agent.post("/api/batches").send({ note: "device blocked on parts" });
  expect(batch.status).toBe(201);
  const batchJson = batch.body as BatchJson;
  const device = await tech.agent
    .post(`/api/batches/${batchJson.id}/devices`)
    .send({ modelName: "iPhone 13", statedIssue: "Cracked screen", ...identifiers });
  expect(device.status).toBe(201);
  const manager = await harness.loginAs(DEFAULT_MANAGER_EMAIL);
  expect(
    (await manager.agent.post(`/api/batches/${batchJson.id}/devices/approve-all`).send({})).status
  ).toBe(200);
  expect(
    (await manager.agent.post(`/api/batches/${batchJson.id}/approve`).send({ note: "costs approved" }))
      .status
  ).toBe(200);
  const result = harness.db
    .prepare(
      `INSERT INTO demand_records (sku_id, batch_id, device_id, supplier, status, created_at, created_by)
       VALUES (?, ?, ?, NULL, 'open', ?, ?)`
    )
    .run(
      skuId,
      batchJson.id,
      (device.body as DeviceJson).id,
      harness.clock.now().toISOString(),
      tech.user.id
    );
  return { demandId: Number(result.lastInsertRowid), batchNumber: batchJson.number };
}

describe("POST /api/purchase-orders", () => {
  let harness: TestHarness;
  let tech: Agent;
  let techUser: LoggedInAgent;
  let skuA: number;
  let skuB: number;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  beforeEach(async () => {
    techUser = await harness.createUserAs("tech@acme.co", "tech");
    tech = techUser.agent;
    skuA = await createSku(tech, "iPhone 13 Screen");
    skuB = await createSku(tech, "iPad 9 Screen", "0.50");
  });

  it("requires a session", async () => {
    const response = await harness.request.post("/api/purchase-orders").send(poBody([skuA]));
    expect(response.status).toBe(401);
  });

  it("requires a purpose, an opening note, and at least one line", async () => {
    for (const body of [
      { ...poBody([skuA]), purpose: "" },
      { ...poBody([skuA]), note: "   " },
      { ...poBody([skuA]), note: undefined },
      { ...poBody([skuA]), lines: [] },
      { ...poBody([skuA]), purpose: undefined },
    ]) {
      const response = await tech.post("/api/purchase-orders").send(body);
      expect(response.status).toBe(400);
      expect(String(response.body.error)).toMatch(/purpose|note|line/i);
    }
  });

  it("rejects unknown SKUs, bad unit prices, and non-positive quantities", async () => {
    const unknownSku = await tech
      .post("/api/purchase-orders")
      .send(poBody([99999]));
    expect(unknownSku.status).toBe(400);
    expect(String(unknownSku.body.error)).toContain("no SKU with id 99999");

    for (const unitPrice of ["12.345", "-1", "abc"]) {
      const response = await tech
        .post("/api/purchase-orders")
        .send(poBody([skuA], { lines: [{ skuId: skuA, quantity: 1, unitPrice }] }));
      expect(response.status).toBe(400);
      expect(String(response.body.error)).toContain("unit price");
    }

    const zeroQuantity = await tech
      .post("/api/purchase-orders")
      .send(poBody([skuA], { lines: [{ skuId: skuA, quantity: 0, unitPrice: "1.00" }] }));
    expect(zeroQuantity.status).toBe(400);

    const badShipping = await tech
      .post("/api/purchase-orders")
      .send(poBody([skuA], { shippingCost: "4.999" }));
    expect(badShipping.status).toBe(400);
    expect(String(badShipping.body.error)).toContain("shipping");
  });

  it("captures the full paperwork, assigns sequential numbers, and starts Awaiting approval", async () => {
    const first = await tech.post("/api/purchase-orders").send(
      poBody([skuA, skuB], {
        lines: [
          { skuId: skuA, quantity: 2, unitPrice: "12.34", source: "MobileSentrix" },
          { skuId: skuB, quantity: 1, unitPrice: "0.50", source: "AliExpress" },
        ],
      })
    );
    const second = await tech.post("/api/purchase-orders").send(poBody([skuA]));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.number).toBe(1);
    expect(second.body.number).toBe(2);

    const po = first.body as PoDetailJson;
    expect(po.status).toBe("Awaiting approval");
    expect(po.purpose).toBe("Weekly screens restock");
    expect(po.sources).toBe("MobileSentrix");
    expect(po.shippingCost).toBe("9.99");
    expect(po.createdBy.email).toBe("tech@acme.co");
    expect(po.approvedAt).toBeNull();
    expect(po.lines).toHaveLength(2);
    expect(po.lines[0]).toMatchObject({
      sku: { id: skuA, name: "iPhone 13 Screen" },
      quantity: 2,
      unitPrice: "12.34",
      unitPriceCents: 1234,
      source: "MobileSentrix",
    });
    // 2 × $12.34 + 1 × $0.50 + $9.99 shipping = $35.17
    expect(po.lines[1]).toMatchObject({
      quantity: 1,
      unitPrice: "0.50",
      unitPriceCents: 50,
      source: "AliExpress",
    });
    expect(po.totalCents).toBe(3517);
    expect(po.total).toBe("35.17");
    expect(po.tracking).toHaveLength(1);
    expect(po.tracking[0]).toMatchObject({
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      addedBy: { email: "tech@acme.co" },
    });
    expect(po.demandIds).toEqual([]);

    const bare = await tech
      .post("/api/purchase-orders")
      .send(poBody([skuA], { shippingCost: undefined, tracking: undefined, sources: undefined }));
    expect(bare.status).toBe(201);
    expect(bare.body.shippingCost).toBe("0.00");
    expect(bare.body.totalCents).toBe(2468);
    expect(bare.body.sources).toBeNull();
    expect(bare.body.tracking).toEqual([]);
  });

  it("records the opening note and tracking as timeline events in creation order", async () => {
    const created = await tech.post("/api/purchase-orders").send(poBody([skuA]));
    const po = created.body as PoDetailJson;

    expect(po.events.map((event) => event.action)).toEqual([
      "po.created",
      "note.added",
      "po.tracking_added",
    ]);
    expect(po.events.every((event) => event.entityType === "po")).toBe(true);
    expect(po.events[0].actor).toMatchObject({ email: "tech@acme.co" });
    expect(po.events[1].payload).toEqual({ text: "Ordering for batch #3 devices" });
    expect(po.events[2].payload).toEqual({
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
    });
  });

  it("marks real demand records as ordered via the purchase_order_demand link table (a line may cover SEVERAL)", async () => {
    // INTEGRATION (ticket 05): the demand table exists, so demand ids are
    // validated — unknown ids are refused, real ones are linked and stop
    // appearing as outstanding.
    const demandId = await seedDemandRow(harness, techUser, skuA, "MobileSentrix");

    const unknown = await tech.post("/api/purchase-orders").send(
      poBody([skuA], { lines: [{ skuId: skuA, quantity: 1, unitPrice: "12.34", demandId: 99999 }] })
    );
    expect(unknown.status).toBe(400);
    expect(String(unknown.body.error)).toContain("demand");

    const created = await tech.post("/api/purchase-orders").send(
      poBody([skuA], {
        lines: [{ skuId: skuA, quantity: 1, unitPrice: "12.34", demandId }],
      })
    );
    expect(created.status).toBe(201);
    const po = created.body as PoDetailJson;
    expect(po.demandIds).toEqual([demandId]);
    expect(po.events.map((event) => event.action)).toContain("po.demand_marked");

    const links = harness.db
      .prepare("SELECT po_id, demand_id FROM purchase_order_demand")
      .all() as Array<{ po_id: number; demand_id: number }>;
    expect(links).toEqual([{ po_id: po.id, demand_id: demandId }]);

    const outstanding = (await tech.get("/api/purchase-orders/demand")).body
      .demand as Array<{ skuId: number }>;
    expect(outstanding).toHaveLength(0);
  });

  it("ONE line covers SEVERAL demand records via demandIds — all linked, all hidden from outstanding", async () => {
    const first = await seedDemandRow(harness, techUser, skuA, "MobileSentrix");
    const second = await seedDemandRow(harness, techUser, skuA, "InjuredGadgets");

    const created = await tech.post("/api/purchase-orders").send(
      poBody([skuA], {
        lines: [
          { skuId: skuA, quantity: 2, unitPrice: "12.34", demandIds: [first, second] },
        ],
      })
    );
    expect(created.status).toBe(201);
    const po = created.body as PoDetailJson;
    // Every linked id is on the PO; the line's demand_id is the first (receipt priority).
    expect(po.demandIds).toEqual([first, second]);
    expect(po.lines[0].demand?.id).toBe(first);

    const links = harness.db
      .prepare("SELECT po_id, demand_id FROM purchase_order_demand ORDER BY demand_id")
      .all() as Array<{ po_id: number; demand_id: number }>;
    expect(links).toEqual([
      { po_id: po.id, demand_id: first },
      { po_id: po.id, demand_id: second },
    ]);

    const outstanding = (await tech.get("/api/purchase-orders/demand")).body.demand as Array<{
      skuId: number;
    }>;
    expect(outstanding).toHaveLength(0);
  });

  it("links a demand id once even when several lines reference it", async () => {
    const demandId = await seedDemandRow(harness, techUser, skuA, "MobileSentrix");
    const created = await tech.post("/api/purchase-orders").send(
      poBody([skuA, skuB], {
        lines: [
          { skuId: skuA, quantity: 1, unitPrice: "12.34", demandId },
          { skuId: skuB, quantity: 1, unitPrice: "12.34", demandId },
        ],
      })
    );
    expect(created.status).toBe(201);
    expect((created.body as PoDetailJson).demandIds).toEqual([demandId]);

    const links = harness.db
      .prepare("SELECT po_id, demand_id FROM purchase_order_demand")
      .all() as Array<{ po_id: number; demand_id: number }>;
    expect(links).toEqual([{ po_id: (created.body as PoDetailJson).id, demand_id: demandId }]);
  });
});

describe("GET /api/purchase-orders", () => {
  let harness: TestHarness;
  let tech: Agent;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  beforeEach(async () => {
    tech = (await harness.createUserAs("tech@acme.co", "tech")).agent;
  });

  it("requires a session", async () => {
    const response = await harness.request.get("/api/purchase-orders");
    expect(response.status).toBe(401);
  });

  it("lists newest-first summaries", async () => {
    const sku = await createSku(tech, "iPhone 13 Screen");
    await tech.post("/api/purchase-orders").send(poBody([sku]));
    await tech.post("/api/purchase-orders").send(poBody([sku]));

    const list = await tech.get("/api/purchase-orders");
    expect(list.status).toBe(200);
    const summaries = list.body as PoSummaryJson[];
    expect(summaries.map((po) => po.number)).toEqual([2, 1]);
    expect(summaries[0]).toMatchObject({
      purpose: "Weekly screens restock",
      status: "Awaiting approval",
      lineCount: 1,
      trackingCount: 1,
      totalCents: 2468 + 999,
      total: "34.67",
    });
    expect(summaries[0].createdBy.email).toBe("tech@acme.co");
  });
});

describe("GET /api/purchase-orders/:id", () => {
  let harness: TestHarness;
  let techUser: LoggedInAgent;
  let tech: Agent;

  beforeEach(async () => {
    harness = createTestHarness();
    techUser = await harness.createUserAs("tech@acme.co", "tech");
    tech = techUser.agent;
  });

  afterEach(() => {
    harness.close();
  });

  it("rejects unknown and malformed ids", async () => {
    expect((await tech.get("/api/purchase-orders/999")).status).toBe(404);
    expect((await tech.get("/api/purchase-orders/abc")).status).toBe(400);
  });

  it("returns the detail with lines, tracking, and the timeline", async () => {
    const sku = await createSku(tech, "iPhone 13 Screen");
    const created = await tech.post("/api/purchase-orders").send(poBody([sku]));
    const id = (created.body as PoDetailJson).id;

    const detail = await tech.get(`/api/purchase-orders/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(id);
    expect((detail.body as PoDetailJson).events.length).toBeGreaterThanOrEqual(3);

    const timeline = await tech.get(`/api/purchase-orders/${id}/timeline`);
    expect(timeline.status).toBe(200);
    expect((timeline.body as EventJson[]).map((event) => event.action)).toEqual([
      "po.created",
      "note.added",
      "po.tracking_added",
    ]);
  });

  it("labels each line's demand with the batch number and device identifier (ticket 04)", async () => {
    const skuAsset = await createSku(tech, "iPhone 13 Screen");
    const skuImei = await createSku(tech, "iPhone 13 Battery");
    const skuSerial = await createSku(tech, "iPhone 13 Back Glass");
    const skuBatchOnly = await createSku(tech, "iPhone 13 Camera");
    const skuNone = await createSku(tech, "iPhone 13 Port");

    // Identifier precedence per the ticket-04 decision: Asset ID, else
    // IMEI, else serial number — so a device carrying all three shows the
    // Asset ID, and each single-identifier device shows its own.
    const assetDemand = await seedDeviceDemand(harness, techUser, skuAsset, {
      assetId: "A-77",
      imei: "111111111111111",
      serialNumber: "SN-1",
    });
    const imeiDemand = await seedDeviceDemand(harness, techUser, skuImei, {
      imei: "222222222222222",
    });
    const serialDemand = await seedDeviceDemand(harness, techUser, skuSerial, {
      serialNumber: "SN-9",
    });
    const batchOnlyDemandId = await seedDemandRow(harness, techUser, skuBatchOnly, "MobileSentrix");
    const batchOnly = harness.db
      .prepare(
        "SELECT b.number AS number FROM demand_records r JOIN batches b ON b.id = r.batch_id WHERE r.id = ?"
      )
      .get(batchOnlyDemandId) as { number: number };

    const created = await tech.post("/api/purchase-orders").send(
      poBody([skuAsset], {
        lines: [
          { skuId: skuAsset, quantity: 1, unitPrice: "12.34", demandId: assetDemand.demandId },
          { skuId: skuImei, quantity: 1, unitPrice: "12.34", demandId: imeiDemand.demandId },
          { skuId: skuSerial, quantity: 1, unitPrice: "12.34", demandId: serialDemand.demandId },
          { skuId: skuBatchOnly, quantity: 1, unitPrice: "12.34", demandId: batchOnlyDemandId },
          { skuId: skuNone, quantity: 1, unitPrice: "12.34" },
        ],
      })
    );
    expect(created.status).toBe(201);

    const detail = await tech.get(`/api/purchase-orders/${(created.body as PoDetailJson).id}`);
    expect(detail.status).toBe(200);
    expect((detail.body as PoDetailJson).lines.map((line) => line.demand)).toEqual([
      { id: assetDemand.demandId, batchNumber: assetDemand.batchNumber, device: "A-77" },
      { id: imeiDemand.demandId, batchNumber: imeiDemand.batchNumber, device: "222222222222222" },
      { id: serialDemand.demandId, batchNumber: serialDemand.batchNumber, device: "SN-9" },
      // Batch-only demand (no device): the batch alone.
      { id: batchOnlyDemandId, batchNumber: batchOnly.number, device: null },
      // No demand at all.
      null,
    ]);
  });
});

describe("POST /api/purchase-orders/:id/notes", () => {
  let harness: TestHarness;
  let tech: Agent;
  let poId: number;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = (await harness.createUserAs("tech@acme.co", "tech")).agent;
    const sku = await createSku(tech, "iPhone 13 Screen");
    const created = await tech.post("/api/purchase-orders").send(poBody([sku]));
    poId = (created.body as PoDetailJson).id;
  });

  afterEach(() => {
    harness.close();
  });

  it("requires note text", async () => {
    for (const note of [undefined, "", "  "]) {
      const response = await tech
        .post(`/api/purchase-orders/${poId}/notes`)
        .send(note === undefined ? {} : { note });
      expect(response.status).toBe(400);
      expect(String(response.body.error)).toContain("note");
    }
  });

  it("rejects unknown POs", async () => {
    expect((await tech.post("/api/purchase-orders/999/notes").send({ note: "x" })).status).toBe(404);
  });

  it("appends an immutable note to the timeline", async () => {
    const added = await tech.post(`/api/purchase-orders/${poId}/notes`).send({
      note: "Vendor confirmed ship date",
    });
    expect(added.status).toBe(201);
    expect(added.body.action).toBe("note.added");
    expect(added.body.payload).toEqual({ text: "Vendor confirmed ship date" });

    const timeline = await tech.get(`/api/purchase-orders/${poId}/timeline`);
    const actions = (timeline.body as EventJson[]).map((event) => event.action);
    expect(actions).toEqual(["po.created", "note.added", "po.tracking_added", "note.added"]);

    // No note or event can be edited or deleted — there is no such route.
    const firstNote = (timeline.body as EventJson[]).find(
      (event) => event.action === "note.added"
    ) as EventJson;
    const edited = await tech
      .put(`/api/purchase-orders/${poId}/notes/${firstNote.id}`)
      .send({ note: "rewritten" });
    expect(edited.status).toBe(404);
    const deleted = await tech.delete(`/api/purchase-orders/${poId}/notes/${firstNote.id}`);
    expect(deleted.status).toBe(404);
  });
});

describe("POST /api/purchase-orders/:id/approve", () => {
  let harness: TestHarness;
  let manager: Agent;
  let tech: Agent;
  let poId: number;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = (await harness.loginAs(MANAGER)).agent;
    tech = (await harness.createUserAs("tech@acme.co", "tech")).agent;
    const sku = await createSku(tech, "iPhone 13 Screen");
    const created = await tech.post("/api/purchase-orders").send(poBody([sku]));
    poId = (created.body as PoDetailJson).id;
  });

  afterEach(() => {
    harness.close();
  });

  it("refuses techs", async () => {
    const response = await tech
      .post(`/api/purchase-orders/${poId}/approve`)
      .send({ note: "looks good" });
    expect(response.status).toBe(403);

    const detail = await tech.get(`/api/purchase-orders/${poId}`);
    expect((detail.body as PoDetailJson).status).toBe("Awaiting approval");
  });

  it("approves WITHOUT a note — the note is optional, the sign-off is the record", async () => {
    harness.clock.advance(60_000);
    const approved = await manager.post(`/api/purchase-orders/${poId}/approve`).send({});
    expect(approved.status).toBe(200);

    const po = approved.body as PoDetailJson;
    expect(po.status).toBe("In-transit");

    const statusEvent = po.events.find((event) => event.action === "po.status_changed");
    expect(statusEvent).toBeDefined();
    // A noteless approval records NO note at all — the payload simply lacks
    // the key (JSON.stringify drops undefined), the same payload shape the
    // optional device-decision note uses.
    expect(statusEvent!.payload).toEqual({ from: "Awaiting approval", to: "In-transit" });
  });

  it("refuses a given-but-blank note — optional never means silently dropped", async () => {
    for (const note of ["", "   "]) {
      const response = await manager
        .post(`/api/purchase-orders/${poId}/approve`)
        .send({ note });
      expect(response.status).toBe(400);
      expect(String(response.body.error)).toContain("blank");
    }
    // The refusals changed nothing — the PO is still awaiting approval.
    const detail = await manager.get(`/api/purchase-orders/${poId}`);
    expect((detail.body as PoDetailJson).status).toBe("Awaiting approval");
  });

  it("rejects unknown POs", async () => {
    expect(
      (await manager.post("/api/purchase-orders/999/approve").send({ note: "x" })).status
    ).toBe(404);
  });

  it("moves the PO to In-transit and stamps who and when", async () => {
    harness.clock.advance(60_000);
    const approved = await manager
      .post(`/api/purchase-orders/${poId}/approve`)
      .send({ note: "Spend approved — ship it" });
    expect(approved.status).toBe(200);

    const po = approved.body as PoDetailJson;
    expect(po.status).toBe("In-transit");
    expect(po.approvedBy).toMatchObject({ email: MANAGER });
    expect(po.approvedAt).not.toBeNull();

    const statusEvent = po.events.find((event) => event.action === "po.status_changed");
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.actor).toMatchObject({ email: MANAGER });
    expect(statusEvent!.payload).toEqual({
      from: "Awaiting approval",
      to: "In-transit",
      note: "Spend approved — ship it",
    });

    // The approval is stamped by the injectable clock, not wall time.
    expect(new Date(po.approvedAt!).toISOString()).toBe(
      new Date("2026-09-24T12:01:00.000Z").toISOString()
    );
  });

  it("refuses to approve a PO that already left Awaiting approval", async () => {
    await manager.post(`/api/purchase-orders/${poId}/approve`).send({ note: "first" });
    const again = await manager
      .post(`/api/purchase-orders/${poId}/approve`)
      .send({ note: "second" });
    expect(again.status).toBe(409);
  });
});

describe("POST /api/purchase-orders/:id/tracking", () => {
  let harness: TestHarness;
  let tech: Agent;
  let poId: number;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = (await harness.createUserAs("tech@acme.co", "tech")).agent;
    const sku = await createSku(tech, "iPhone 13 Screen");
    const created = await tech.post("/api/purchase-orders").send(poBody([sku]));
    poId = (created.body as PoDetailJson).id;
  });

  afterEach(() => {
    harness.close();
  });

  it("requires a carrier and a tracking number", async () => {
    for (const body of [
      {},
      { carrier: "UPS" },
      { trackingNumber: "1Z999" },
      { carrier: "  ", trackingNumber: "1Z999" },
    ]) {
      const response = await tech.post(`/api/purchase-orders/${poId}/tracking`).send(body);
      expect(response.status).toBe(400);
      expect(String(response.body.error)).toMatch(/carrier|tracking/i);
    }
  });

  it("rejects unknown POs", async () => {
    expect(
      (
        await tech
          .post("/api/purchase-orders/999/tracking")
          .send({ carrier: "UPS", trackingNumber: "1Z" })
      ).status
    ).toBe(404);
  });

  it("appends multiple tracking entries with timeline events", async () => {
    const added = await tech
      .post(`/api/purchase-orders/${poId}/tracking`)
      .send({ carrier: "USPS", trackingNumber: "9400111899223197428490" });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      carrier: "USPS",
      trackingNumber: "9400111899223197428490",
      addedBy: { email: "tech@acme.co" },
    });

    const detail = await tech.get(`/api/purchase-orders/${poId}`);
    const po = detail.body as PoDetailJson;
    expect(po.tracking).toHaveLength(2);
    expect(po.trackingCount).toBe(2);
    expect(po.events.filter((event) => event.action === "po.tracking_added")).toHaveLength(2);
  });
});

describe("GET /api/purchase-orders/suggestions", () => {
  let harness: TestHarness;
  let tech: Agent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = (await harness.createUserAs("tech@acme.co", "tech")).agent;
  });

  afterEach(() => {
    harness.close();
  });

  it("suggests distinct purposes and sources from history, freshest first", async () => {
    const sku = await createSku(tech, "iPhone 13 Screen");
    await tech.post("/api/purchase-orders").send(
      poBody([sku], {
        purpose: "Screens restock",
        sources: "MobileSentrix",
        lines: [{ skuId: sku, quantity: 1, unitPrice: "12.34", source: "MobileSentrix" }],
      })
    );
    await tech.post("/api/purchase-orders").send(
      poBody([sku], {
        purpose: "Screens restock",
        sources: "AliExpress",
        lines: [{ skuId: sku, quantity: 1, unitPrice: "12.34", source: "InjuredGadgets" }],
      })
    );

    const response = await tech.get("/api/purchase-orders/suggestions");
    expect(response.status).toBe(200);
    const suggestions = response.body as { purposes: string[]; sources: string[] };
    expect(suggestions.purposes).toEqual(["Screens restock"]);
    // Freshest first; at equal freshness PO-level sources precede line-level.
    expect(suggestions.sources).toEqual(["AliExpress", "InjuredGadgets", "MobileSentrix"]);
  });
});

describe("GET /api/purchase-orders/demand (ticket-05 integration)", () => {
  let harness: TestHarness;
  let techUser: LoggedInAgent;
  let tech: Agent;

  beforeEach(async () => {
    harness = createTestHarness();
    techUser = await harness.createUserAs("tech@acme.co", "tech");
    tech = techUser.agent;
  });

  afterEach(() => {
    harness.close();
  });

  it("lists outstanding demand GROUPED per SKU with the total quantity", async () => {
    const sku = await createSku(tech, "iPhone 13 Screen");
    const response = await tech.get("/api/purchase-orders/demand");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.demand)).toBe(true);
    expect((response.body.demand as unknown[]).length).toBe(0);

    // Three records for one SKU (two batches) → ONE group, quantity 3.
    const demandIdA = await seedDemandRow(harness, techUser, sku, "MobileSentrix");
    const demandIdB = await seedDemandRow(harness, techUser, sku, "MobileSentrix");
    const demandIdC = await seedDemandRow(harness, techUser, sku, "InjuredGadgets");
    const listing = (await tech.get("/api/purchase-orders/demand")).body.demand as Array<{
      skuId: number;
      skuName: string;
      quantity: number;
      demandIds: number[];
      batchIds: number[];
      supplier: string | null;
      suppliers: string[];
    }>;
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatchObject({
      skuId: sku,
      skuName: "iPhone 13 Screen",
      quantity: 3,
      demandIds: [demandIdA, demandIdB, demandIdC],
      supplier: "MobileSentrix",
      suppliers: ["MobileSentrix", "InjuredGadgets"],
    });
    expect(new Set(listing[0].batchIds).size).toBe(3);
  });

  it("NEVER lists demand from a batch that is not approved — ordering waits for sign-off", async () => {
    const sku = await createSku(tech, "iPhone 13 Screen");
    const batch = await tech.post("/api/batches").send({ note: "still awaiting approval" });
    expect(batch.status).toBe(201);
    const preApproval = Number(
      harness.db
        .prepare(
          `INSERT INTO demand_records (sku_id, batch_id, device_id, supplier, status, created_at, created_by)
           VALUES (?, ?, NULL, 'MobileSentrix', 'open', ?, ?)`
        )
        .run(sku, batch.body.id, harness.clock.now().toISOString(), techUser.user.id).lastInsertRowid
    );

    // Not listed while the batch is Awaiting approval...
    const before = (await tech.get("/api/purchase-orders/demand")).body.demand as Array<{
      skuId: number;
    }>;
    expect(before).toHaveLength(0);

    // ...and refused when a PO line tries to link it directly.
    const refused = await tech.post("/api/purchase-orders").send({
      purpose: "ordering pre-approval",
      note: "should be refused",
      lines: [{ skuId: sku, quantity: 1, unitPrice: "12.34", demandIds: [preApproval] }],
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toContain("not approved");

    // After the manager approves the batch, the demand becomes orderable.
    const manager = await harness.loginAs(DEFAULT_MANAGER_EMAIL);
    expect(
      (await manager.agent.post(`/api/batches/${batch.body.id}/approve`).send({ note: "ok" }))
        .status,
    ).toBe(200);
    const after = (await tech.get("/api/purchase-orders/demand")).body.demand as Array<{
      skuId: number;
      demandIds: number[];
    }>;
    expect(after).toHaveLength(1);
    expect(after[0].demandIds).toEqual([preApproval]);
  });

  it("hides demand once any purchase order has marked it ordered", async () => {
    const sku = await createSku(tech, "iPhone 13 Screen");
    const demandId = await seedDemandRow(harness, techUser, sku, "InjuredGadgets");

    const created = await tech.post("/api/purchase-orders").send({
      purpose: "Demand-driven restock",
      note: "Covering the Parts needed demand",
      lines: [{ skuId: sku, quantity: 1, unitPrice: "12.34", demandId }],
    });
    expect(created.status).toBe(201);

    const after = (await tech.get("/api/purchase-orders/demand")).body.demand as Array<{
      skuId: number;
    }>;
    expect(after).toHaveLength(0);
  });

  // Ticket 11: the SKU's default source link rides the group so the PO
  // form's line-source prefill prefers it over the demand record's own
  // supplier.
  it("threads the SKU's default source link through each demand group", async () => {
    const withDefault = await tech
      .post("/api/skus")
      .send({ name: "iPhone 13 Screen", price: "12.34", kind: "serialized", defaultSourceUrl: "source.com/part" });
    expect(withDefault.status).toBe(201);
    const withoutDefault = await createSku(tech, "iPad 9 Screen");

    await seedDemandRow(harness, techUser, (withDefault.body as SkuJson).id, "MobileSentrix");
    await seedDemandRow(harness, techUser, withoutDefault, "InjuredGadgets");

    const listing = (await tech.get("/api/purchase-orders/demand")).body.demand as Array<{
      skuId: number;
      supplier: string | null;
      defaultSourceUrl: string | null;
    }>;
    expect(listing).toHaveLength(2);
    expect(listing.find((group) => group.skuId === (withDefault.body as SkuJson).id)).toMatchObject({
      supplier: "MobileSentrix",
      defaultSourceUrl: "source.com/part",
    });
    // A SKU without a default leaves the field null — the prefill falls
    // back to the demand record's supplier, exactly the old behavior.
    expect(listing.find((group) => group.skuId === withoutDefault)).toMatchObject({
      supplier: "InjuredGadgets",
      defaultSourceUrl: null,
    });
  });

  // One outstanding-demand definition behind both endpoints (final review F1 /
  // architecture C): a demand linked to a PO is not outstanding anywhere —
  // the global queue and the PO form must agree.
  it("the global /api/demand queue agrees with the PO form once a demand is linked to a PO", async () => {
    const sku = await createSku(tech, "iPhone 13 Screen");
    const linked = await seedDemandRow(harness, techUser, sku, "MobileSentrix");
    const unlinked = await seedDemandRow(harness, techUser, sku, "InjuredGadgets");

    const created = await tech.post("/api/purchase-orders").send({
      purpose: "Demand-driven restock",
      note: "Covering the Parts needed demand",
      lines: [{ skuId: sku, quantity: 1, unitPrice: "12.34", demandId: linked }],
    });
    expect(created.status).toBe(201);

    const poGroupIds = (
      (await tech.get("/api/purchase-orders/demand")).body.demand as Array<{
        demandIds: number[];
      }>
    ).flatMap((group) => group.demandIds);
    const globalQueue = (
      (await tech.get("/api/demand")).body.demand as Array<{ id: number }>
    ).map((row) => row.id);

    // Same definition behind both endpoints: the same outstanding ids — the
    // linked one is in neither, the unlinked one in both.
    expect(poGroupIds).not.toContain(linked);
    expect(globalQueue).not.toContain(linked);
    expect(globalQueue).toContain(unlinked);
    expect(poGroupIds).toEqual([unlinked]);
  });

  // The migration runner is the contract: `demand_records` exists in any
  // database the app opens (review S1 / architecture C). Its absence is a
  // broken database and must surface as a loud 500 through the central error
  // handler — never as a silent "no demand" or an unvalidated link.
  it("fails loudly when the demand table is missing instead of degrading to an empty list", async () => {
    harness.db.exec("DROP TABLE demand_records");

    const response = await tech.get("/api/purchase-orders/demand");
    expect(response.status).toBe(500);
  });

  it("refuses to create a purchase order whose demand links it cannot validate", async () => {
    const sku = await createSku(tech, "iPhone 13 Screen");
    harness.db.exec("DROP TABLE demand_records");

    const created = await tech.post("/api/purchase-orders").send(
      poBody([sku], { lines: [{ skuId: sku, quantity: 1, unitPrice: "12.34", demandId: 1 }] })
    );
    expect(created.status).toBe(500);

    const pos = harness.db
      .prepare("SELECT COUNT(*) AS n FROM purchase_orders")
      .get() as { n: number };
    expect(pos.n).toBe(0);
  });
});

describe("batch demand rows name the PO that already carries them (ticket 29)", () => {
  let harness: TestHarness;
  let techUser: LoggedInAgent;
  let tech: Agent;

  beforeEach(async () => {
    harness = createTestHarness();
    techUser = await harness.createUserAs("tech@acme.co", "tech");
    tech = techUser.agent;
  });

  afterEach(() => {
    harness.close();
  });

  it("an ordered-but-not-received demand shows orderedOn instead of a stale Need to Order", async () => {
    const sku = await createSku(tech, "iPhone 13 Screen");
    const demandId = await seedDemandRow(harness, techUser, sku, "MobileSentrix");
    const batchId = (
      harness.db.prepare("SELECT batch_id FROM demand_records WHERE id = ?").get(demandId) as {
        batch_id: number;
      }
    ).batch_id;

    // Before ordering: no PO carries the demand.
    const before = (await tech.get(`/api/batches/${batchId}/demand`)).body.demand as Array<{
      id: number;
      orderedOn: { poNumber: number; poStatus: string } | null;
    }>;
    expect(before[0].orderedOn).toBeNull();

    await tech.post("/api/purchase-orders").send({
      purpose: "Demand-driven restock",
      note: "Covering the Parts needed demand",
      lines: [{ skuId: sku, quantity: 1, unitPrice: "12.34", demandId }],
    });

    const after = (await tech.get(`/api/batches/${batchId}/demand`)).body.demand as Array<{
      id: number;
      orderedOn: { poNumber: number; poStatus: string } | null;
    }>;
    // The device panel must be able to say "in transit on PO #1", not the lie.
    expect(after[0].orderedOn).toEqual({ poNumber: 1, poStatus: "Awaiting approval" });
  });
});

describe("POST /api/purchase-orders/:id/shipping-cost", () => {
  let harness: TestHarness;
  let manager: Agent;
  let tech: Agent;
  let poId: number;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = (await harness.loginAs(MANAGER)).agent;
    tech = (await harness.createUserAs("tech@acme.co", "tech")).agent;
    const sku = await createSku(tech, "iPhone 13 Screen");
    const created = await tech.post("/api/purchase-orders").send(poBody([sku]));
    expect(created.status).toBe(201);
    poId = (created.body as PoDetailJson).id;
  });

  afterEach(() => {
    harness.close();
  });

  it("refuses techs (manager-only, like approval)", async () => {
    const response = await tech
      .post(`/api/purchase-orders/${poId}/shipping-cost`)
      .send({ shippingCost: "4.50", note: "actual freight quote" });
    expect(response.status).toBe(403);

    const detail = await tech.get(`/api/purchase-orders/${poId}`);
    expect((detail.body as PoDetailJson).shippingCostCents).toBe(999);
    expect((detail.body as PoDetailJson).events.some((e) => e.action === "po.shipping_changed")).toBe(false);
  });

  it("accepts a change WITHOUT a note — the change itself is the record", async () => {
    const response = await manager
      .post(`/api/purchase-orders/${poId}/shipping-cost`)
      .send({ shippingCost: "4.50" });
    expect(response.status).toBe(200);

    const po = response.body as PoDetailJson;
    expect(po.shippingCost).toBe("4.50");
    // A noteless change records NO note at all — the payload simply lacks
    // the key, the same shape the noteless approval uses.
    const event = po.events.find((e) => e.action === "po.shipping_changed");
    expect(event).toBeDefined();
    expect(event!.payload).toEqual({ from: 999, to: 450 });
  });

  it("refuses a given-but-blank note — optional never means silently dropped", async () => {
    for (const note of ["", "   "]) {
      const response = await manager
        .post(`/api/purchase-orders/${poId}/shipping-cost`)
        .send({ shippingCost: "4.50", note });
      expect(response.status).toBe(400);
      expect(String(response.body.error)).toContain("blank");
    }
    // The refusals changed nothing — the shipping cost is unchanged.
    const detail = await manager.get(`/api/purchase-orders/${poId}`);
    expect((detail.body as PoDetailJson).shippingCostCents).toBe(999);
  });

  it("rejects negative, malformed, and over-precise values with 400", async () => {
    for (const shippingCost of ["-1", "-0.01", "abc", "4.999"]) {
      const response = await manager
        .post(`/api/purchase-orders/${poId}/shipping-cost`)
        .send({ shippingCost, note: "quote" });
      expect(response.status).toBe(400);
      expect(String(response.body.error)).toContain("shipping");
    }

    // Zero itself is legal (the column CHECK is >= 0).
    const zero = await manager
      .post(`/api/purchase-orders/${poId}/shipping-cost`)
      .send({ shippingCost: "0", note: "free freight promo" });
    expect(zero.status).toBe(200);
    expect((zero.body as PoDetailJson).shippingCostCents).toBe(0);
  });

  it("rejects unknown POs and malformed ids", async () => {
    expect(
      (await manager.post("/api/purchase-orders/999/shipping-cost").send({ shippingCost: "4.50", note: "x" }))
        .status
    ).toBe(404);
    expect(
      (await manager.post("/api/purchase-orders/abc/shipping-cost").send({ shippingCost: "4.50", note: "x" }))
        .status
    ).toBe(400);
  });

  it("sets the shipping cost pre-approval, recomputes the total, and records old → new + note on the timeline", async () => {
    const response = await manager
      .post(`/api/purchase-orders/${poId}/shipping-cost`)
      .send({ shippingCost: "4.50", note: "actual freight quote" });
    expect(response.status).toBe(200);

    const po = response.body as PoDetailJson;
    expect(po.status).toBe("Awaiting approval"); // allowed in any pre-Closed status
    expect(po.shippingCost).toBe("4.50");
    expect(po.shippingCostCents).toBe(450);
    // 2 × $12.34 lines + $4.50 shipping = $29.18 — the same total definition
    // as creation (serialize.ts), not a parallel one.
    expect(po.totalCents).toBe(2 * 1234 + 450);
    expect(po.total).toBe("29.18");

    const event = po.events.find((e) => e.action === "po.shipping_changed");
    expect(event).toBeDefined();
    expect(event!.actor).toMatchObject({ email: MANAGER });
    expect(event!.payload).toEqual({ from: 999, to: 450, note: "actual freight quote" });
    // It merges with the existing event timeline, in order.
    expect(po.events.map((e) => e.action)).toEqual([
      "po.created",
      "note.added",
      "po.tracking_added",
      "po.shipping_changed",
    ]);
  });

  it("works on an In-transit PO — the real-freight case", async () => {
    expect(
      (await manager.post(`/api/purchase-orders/${poId}/approve`).send({ note: "ship it" })).status
    ).toBe(200);

    const response = await manager
      .post(`/api/purchase-orders/${poId}/shipping-cost`)
      .send({ shippingCost: "12.75", note: "box was heavier than quoted" });
    expect(response.status).toBe(200);

    const po = response.body as PoDetailJson;
    expect(po.status).toBe("In-transit");
    expect(po.shippingCostCents).toBe(1275);
    expect(po.totalCents).toBe(2 * 1234 + 1275);
    expect(po.events.map((e) => e.action)).toEqual([
      "po.created",
      "note.added",
      "po.tracking_added",
      "po.status_changed",
      "po.serials_assigned",
      "po.shipping_changed",
    ]);
  });

  it("refuses a Closed PO", async () => {
    expect(
      (await manager.post(`/api/purchase-orders/${poId}/approve`).send({ note: "ship it" }))
        .status
    ).toBe(200);
    // Nothing received yet, so every line is short and the close is legal.
    expect(
      (await tech.post(`/api/purchase-orders/${poId}/close`).send({ note: "rest cancelled" }))
        .status
    ).toBe(200);

    const response = await manager
      .post(`/api/purchase-orders/${poId}/shipping-cost`)
      .send({ shippingCost: "4.50", note: "too late" });
    expect(response.status).toBe(409);

    const detail = await manager.get(`/api/purchase-orders/${poId}`);
    expect((detail.body as PoDetailJson).shippingCostCents).toBe(999);
    expect(
      (detail.body as PoDetailJson).events.some((e) => e.action === "po.shipping_changed")
    ).toBe(false);
  });
});

/**
 * Pre-approval revisions (spec: .scratch/po-pre-approval-edits/spec.md): a
 * PO in Awaiting approval is a draft — the lines can be replaced (SKUs
 * added/removed, quantities/prices adjusted, required note) and a mistaken
 * draft can be deleted outright. Both drive the HTTP seam only.
 */
describe("POST /api/purchase-orders/:id/lines (revise while Awaiting approval)", () => {
  let harness: TestHarness;
  let tech: Agent;
  let techUser: LoggedInAgent;
  let skuA: number;
  let skuB: number;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  beforeEach(async () => {
    techUser = await harness.createUserAs("tech@acme.co", "tech");
    tech = techUser.agent;
    skuA = await createSku(tech, "iPhone 13 Screen");
    skuB = await createSku(tech, "iPad 9 Screen", "0.50");
  });

  async function createPo(lines: Array<Record<string, unknown>>): Promise<PoDetailJson> {
    const response = await tech
      .post("/api/purchase-orders")
      .send(poBody([skuA], { lines }));
    expect(response.status).toBe(201);
    return response.body as PoDetailJson;
  }

  it("replaces the lines — SKUs added, removed, quantities and prices adjusted — and records one event", async () => {
    // Original: 2 × $12.34 + 1 × $0.50 = $25.18 in lines (+ $9.99 shipping).
    const po = await createPo([
      { skuId: skuA, quantity: 2, unitPrice: "12.34", source: "MobileSentrix" },
      { skuId: skuB, quantity: 1, unitPrice: "0.50" },
    ]);

    // Revised: skuB dropped, skuA bumped to 3 @ $13.00, a new line added.
    // 3 × 1300 + 2 × 200 = 4300 lines cents; + 999 shipping = 5299 total.
    const response = await tech.post(`/api/purchase-orders/${po.id}/lines`).send({
      note: "vendor quoted a new screen price; also need chargers",
      lines: [
        { skuId: skuA, quantity: 3, unitPrice: "13.00", source: "MobileSentrix" },
        { skuId: skuB, quantity: 2, unitPrice: "2.00", source: "InjuredGadgets" },
      ],
    });
    expect(response.status).toBe(200);

    const revised = response.body as PoDetailJson;
    expect(revised.lines).toHaveLength(2);
    expect(revised.lines[0]).toMatchObject({
      sku: { id: skuA, name: "iPhone 13 Screen" },
      quantity: 3,
      unitPrice: "13.00",
      unitPriceCents: 1300,
      source: "MobileSentrix",
    });
    expect(revised.lines[1]).toMatchObject({
      sku: { id: skuB, name: "iPad 9 Screen" },
      quantity: 2,
      unitPrice: "2.00",
      unitPriceCents: 200,
      source: "InjuredGadgets",
    });
    // Shipping untouched by a line revision: 4300 + 999 = 5299.
    expect(revised.totalCents).toBe(5299);
    expect(revised.total).toBe("52.99");

    const change = revised.events.find((event) => event.action === "po.lines_changed");
    expect(change).toBeDefined();
    expect(change!.actor).toMatchObject({ email: "tech@acme.co" });
    expect(change!.payload).toMatchObject({
      note: "vendor quoted a new screen price; also need chargers",
      previousLineCount: 2,
      previousLinesTotalCents: 2518,
      linesTotalCents: 4300,
      demandMarked: [],
      demandReleased: [],
    });
    // The event carries the NEW line set; the previous one lives on the
    // prior event in the chain.
    expect(change!.payload!.lines).toEqual([
      { sku: "iPhone 13 Screen", quantity: 3, unitPriceCents: 1300, source: "MobileSentrix" },
      { sku: "iPad 9 Screen", quantity: 2, unitPriceCents: 200, source: "InjuredGadgets" },
    ]);
  });

  it("refuses everything an unapproved PO must refuse: other statuses, blank note, no lines, unknown SKU, bad price", async () => {
    const po = await createPo([{ skuId: skuA, quantity: 1, unitPrice: "12.34" }]);

    // A given-but-blank note and an empty line set are schema refusals, same
    // message shape as creation.
    for (const body of [
      { note: "  ", lines: [{ skuId: skuA, quantity: 1, unitPrice: "12.34" }] },
      { note: "why", lines: [] },
    ]) {
      const response = await tech.post(`/api/purchase-orders/${po.id}/lines`).send(body);
      expect(response.status).toBe(400);
      expect(String(response.body.error)).toMatch(/note|line/i);
    }

    // Per-line refusals name the offending line, exactly as creation does.
    const unknownSku = await tech.post(`/api/purchase-orders/${po.id}/lines`).send({
      note: "why",
      lines: [{ skuId: 99999, quantity: 1, unitPrice: "12.34" }],
    });
    expect(unknownSku.status).toBe(400);
    expect(String(unknownSku.body.error)).toContain("no SKU with id 99999");

    const badPrice = await tech.post(`/api/purchase-orders/${po.id}/lines`).send({
      note: "why",
      lines: [{ skuId: skuA, quantity: 1, unitPrice: "12.345" }],
    });
    expect(badPrice.status).toBe(400);
    expect(String(badPrice.body.error)).toContain("unit price");

    // The note is OPTIONAL: a noteless revision is accepted — the line diff
    // is the record, and the event payload simply lacks the note key.
    const noteless = await tech.post(`/api/purchase-orders/${po.id}/lines`).send({
      lines: [{ skuId: skuA, quantity: 2, unitPrice: "12.34" }],
    });
    expect(noteless.status).toBe(200);
    const notelessEvent = (noteless.body as PoDetailJson).events.find(
      (event) => event.action === "po.lines_changed"
    );
    expect(notelessEvent).toBeDefined();
    expect(notelessEvent!.payload).not.toHaveProperty("note");

    // Approval freezes the paperwork: the shipping cost is the only field
    // with a post-approval edit path.
    const manager = await harness.loginAs(DEFAULT_MANAGER_EMAIL);
    expect(
      (await manager.agent.post(`/api/purchase-orders/${po.id}/approve`).send({ note: "ship it" }))
        .status
    ).toBe(200);
    const frozen = await tech.post(`/api/purchase-orders/${po.id}/lines`).send({
      note: "too late",
      lines: [{ skuId: skuA, quantity: 5, unitPrice: "12.34" }],
    });
    expect(frozen.status).toBe(409);
    expect(String(frozen.body.error)).toContain("Awaiting approval");
    const detail = await tech.get(`/api/purchase-orders/${po.id}`);
    expect((detail.body as PoDetailJson).lines).toHaveLength(1);
  });

  it("keeps a demand link while the SKU still has a line, releases it when the line disappears, marks new refs", async () => {
    const demandId = await seedDemandRow(harness, techUser, skuA, "MobileSentrix");
    const po = await createPo([
      { skuId: skuA, quantity: 1, unitPrice: "12.34", demandId },
    ]);
    expect(po.demandIds).toEqual([demandId]);

    // Quantity bump WITHOUT re-sending the demand ref: the link survives —
    // the SKU is still being ordered, so the demand is still covered.
    const bump = await tech.post(`/api/purchase-orders/${po.id}/lines`).send({
      note: "need one more",
      lines: [{ skuId: skuA, quantity: 2, unitPrice: "12.34" }],
    });
    expect(bump.status).toBe(200);
    expect((bump.body as PoDetailJson).demandIds).toEqual([demandId]);
    expect(
      (bump.body as PoDetailJson).events.find((event) => event.action === "po.lines_changed")!
        .payload
    ).toMatchObject({ demandMarked: [], demandReleased: [] });
    const outstandingAfterBump = (await tech.get("/api/purchase-orders/demand")).body
      .demand as Array<{ skuId: number }>;
    expect(outstandingAfterBump).toHaveLength(0);

    // Drop the skuA line entirely: the demand is released and returns to the
    // outstanding queue.
    const dropped = await tech.post(`/api/purchase-orders/${po.id}/lines`).send({
      note: "screens are fine, only chargers now",
      lines: [{ skuId: skuB, quantity: 4, unitPrice: "0.50" }],
    });
    expect(dropped.status).toBe(200);
    expect((dropped.body as PoDetailJson).demandIds).toEqual([]);
    expect(
      (dropped.body as PoDetailJson).events.find(
        (event) => event.action === "po.lines_changed" && event.payload?.note === "screens are fine, only chargers now"
      )!.payload
    ).toMatchObject({ demandMarked: [], demandReleased: [demandId] });
    const outstandingAfterDrop = (await tech.get("/api/purchase-orders/demand")).body
      .demand as Array<{ skuId: number; demandIds: number[] }>;
    expect(outstandingAfterDrop).toHaveLength(1);
    expect(outstandingAfterDrop[0]).toMatchObject({ skuId: skuA, demandIds: [demandId] });

    // Re-adding a line that explicitly references the demand marks it ordered
    // again.
    const remarketed = await tech.post(`/api/purchase-orders/${po.id}/lines`).send({
      note: "screens do need replacing after all",
      lines: [
        { skuId: skuB, quantity: 4, unitPrice: "0.50" },
        { skuId: skuA, quantity: 1, unitPrice: "12.34", demandId },
      ],
    });
    expect(remarketed.status).toBe(200);
    expect((remarketed.body as PoDetailJson).demandIds).toEqual([demandId]);
    expect(
      (remarketed.body as PoDetailJson).events.find(
        (event) => event.action === "po.lines_changed" && event.payload?.note === "screens do need replacing after all"
      )!.payload
    ).toMatchObject({ demandMarked: [demandId], demandReleased: [] });
  });

  it("refuses a demand reference whose batch is not approved, as creation does", async () => {
    // A demand on an Awaiting-approval batch: an estimate the manager has
    // not signed off, so it cannot be marked ordered — same rule as create.
    const batch = await techUser.agent.post("/api/batches").send({ note: "not approved yet" });
    expect(batch.status).toBe(201);
    const unapproved = harness.db
      .prepare(
        `INSERT INTO demand_records (sku_id, batch_id, device_id, supplier, status, created_at, created_by)
         VALUES (?, ?, NULL, NULL, 'open', ?, ?)`
      )
      .run(skuA, (batch.body as BatchJson).id, harness.clock.now().toISOString(), techUser.user.id);
    const demandId = Number(unapproved.lastInsertRowid);

    const po = await createPo([{ skuId: skuB, quantity: 1, unitPrice: "0.50" }]);
    const response = await tech.post(`/api/purchase-orders/${po.id}/lines`).send({
      note: "trying to order an unapproved demand",
      lines: [{ skuId: skuA, quantity: 1, unitPrice: "12.34", demandId }],
    });
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toContain("not approved");
    expect((await tech.get(`/api/purchase-orders/${po.id}`)).body.demandIds).toEqual([]);
  });
});

describe("DELETE /api/purchase-orders/:id (delete a draft)", () => {
  let harness: TestHarness;
  let tech: Agent;
  let techUser: LoggedInAgent;
  let skuA: number;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  beforeEach(async () => {
    techUser = await harness.createUserAs("tech@acme.co", "tech");
    tech = techUser.agent;
    skuA = await createSku(tech, "iPhone 13 Screen");
  });

  it("hard-deletes the draft, its children, and its timeline; the linked demand returns to outstanding", async () => {
    const demandId = await seedDemandRow(harness, techUser, skuA, "MobileSentrix");
    const created = await tech.post("/api/purchase-orders").send(
      poBody([skuA], {
        lines: [{ skuId: skuA, quantity: 1, unitPrice: "12.34", demandId }],
      })
    );
    expect(created.status).toBe(201);
    const po = created.body as PoDetailJson;
    expect(po.demandIds).toEqual([demandId]);

    const response = await tech.delete(`/api/purchase-orders/${po.id}`);
    expect(response.status).toBe(200);

    // The PO is gone from every read surface.
    expect((await tech.get(`/api/purchase-orders/${po.id}`)).status).toBe(404);
    const list = (await tech.get("/api/purchase-orders")).body as PoSummaryJson[];
    expect(list.some((row) => row.id === po.id)).toBe(false);

    // Direct db asserts: nothing half-deleted — the children and the PO's
    // timeline went with the row.
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM purchase_orders").get()).toMatchObject({
      n: 0,
    });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM purchase_order_lines").get()).toMatchObject({
      n: 0,
    });
    expect(harness.db.prepare("SELECT COUNT(*) AS n FROM purchase_order_tracking").get()).toMatchObject({
      n: 0,
    });
    expect(
      harness.db.prepare("SELECT COUNT(*) AS n FROM purchase_order_demand").get()
    ).toMatchObject({ n: 0 });
    expect(
      harness.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE entity_type = 'po' AND entity_id = ?")
        .get(po.id)
    ).toMatchObject({ n: 0 });

    // The demand was only MARKED ordered, never fulfilled — deleting the
    // link returns it to the outstanding queue.
    const outstanding = (await tech.get("/api/purchase-orders/demand")).body
      .demand as Array<{ skuId: number; demandIds: number[] }>;
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]).toMatchObject({ skuId: skuA, demandIds: [demandId] });
    const demand = harness.db
      .prepare("SELECT status FROM demand_records WHERE id = ?")
      .get(demandId) as { status: string };
    expect(demand.status).toBe("open");
  });

  it("refuses after approval and leaves the PO intact", async () => {
    const created = await tech.post("/api/purchase-orders").send(poBody([skuA]));
    const po = created.body as PoDetailJson;
    const manager = await harness.loginAs(DEFAULT_MANAGER_EMAIL);
    expect(
      (await manager.agent.post(`/api/purchase-orders/${po.id}/approve`).send({ note: "ship it" }))
        .status
    ).toBe(200);

    const response = await tech.delete(`/api/purchase-orders/${po.id}`);
    expect(response.status).toBe(409);
    expect(String(response.body.error)).toContain("Awaiting approval");

    // The approved PO and its assigned serials are untouched.
    const detail = await tech.get(`/api/purchase-orders/${po.id}`);
    expect(detail.status).toBe(200);
    expect((detail.body as PoDetailJson).status).toBe("In-transit");
    expect((detail.body as PoDetailJson).expectedSerials!.length).toBeGreaterThan(0);
  });

  it("answers 404 for an unknown id", async () => {
    const response = await tech.delete("/api/purchase-orders/99999");
    expect(response.status).toBe(404);
  });

  it("frees the sequential number — the next PO reuses it", async () => {
    const first = await tech.post("/api/purchase-orders").send(poBody([skuA]));
    expect((first.body as PoDetailJson).number).toBe(1);
    await tech.delete(`/api/purchase-orders/${(first.body as PoDetailJson).id}`);
    const next = await tech.post("/api/purchase-orders").send(poBody([skuA]));
    expect(next.status).toBe(201);
    // Numbers are human labels (MAX+1), not gapless ledger ids: a deleted
    // draft's number is reusable.
    expect((next.body as PoDetailJson).number).toBe(1);
  });
});
