import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

/**
 * Ticket 08 — labels and scan-to-receive: expected serial pre-assignment,
 * duplicate/unknown rejection, partial vs received status, SKU price refresh,
 * auto-reservation into outstanding demand, and close-with-shortfall.
 */

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

interface PoDetail {
  id: number;
  number: number;
  status: string;
  lines: Array<{
    id: number;
    sku: { id: number; name: string; kind: string };
    quantity: number;
    receivedQuantity: number;
    shortfall: number;
    unitPriceCents: number;
    demandId: number | null;
  }>;
  expectedSerials: Array<{
    serial: string;
    received: boolean;
    partId: number | null;
    lineId: number;
    sku: { id: number; name: string };
  }>;
  shortfallTotal: number;
  closedNote: string | null;
  events: Array<{ action: string; payload: Record<string, unknown> | null }>;
}

async function createSku(
  agent: Agent,
  name: string,
  price = "10.00"
): Promise<number> {
  const response = await agent.post("/api/skus").send({ name, price, kind: "serialized" });
  expect(response.status).toBe(201);
  return response.body.id as number;
}

async function createApprovedPo(
  tech: Agent,
  manager: Agent,
  lines: Array<{ skuId: number; quantity: number; unitPrice: string; demandId?: number }>
): Promise<PoDetail> {
  const created = await tech.post("/api/purchase-orders").send({
    purpose: "Restock for receiving tests",
    note: "Opening note",
    lines: lines.map((line) => ({
      skuId: line.skuId,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      ...(line.demandId !== undefined ? { demandId: line.demandId } : {}),
    })),
  });
  expect(created.status).toBe(201);
  const approved = await manager
    .post(`/api/purchase-orders/${created.body.id}/approve`)
    .send({ note: "Approved for receiving" });
  expect(approved.status).toBe(200);
  return approved.body as PoDetail;
}

async function seedDemandWithDevice(
  harness: TestHarness,
  tech: LoggedInAgent,
  skuId: number,
  imei = "356938035643809"
): Promise<{ demandId: number; batchId: number; deviceId: number }> {
  const batch = await tech.agent.post("/api/batches").send({ note: "blocked on parts" });
  expect(batch.status).toBe(201);
  const device = await tech.agent.post(`/api/batches/${batch.body.id}/devices`).send({
    modelName: "iPhone 12",
    imei,
    statedIssue: "cracked screen",
  });
  expect(device.status).toBe(201);
  // Demand is orderable only from an APPROVED (Open) batch — approve it, as
  // the manager would at triage sign-off.
  const manager = await harness.loginAs(DEFAULT_MANAGER_EMAIL);
  const decided = await manager.agent
    .post(`/api/batches/${batch.body.id}/devices/${device.body.id}/approval`)
    .send({ decision: "approved" });
  expect(decided.status).toBe(200);
  const approved = await manager.agent
    .post(`/api/batches/${batch.body.id}/approve`)
    .send({ note: "costs approved" });
  expect(approved.status).toBe(200);
  const demandId = Number(
    harness.db
      .prepare(
        `INSERT INTO demand_records (sku_id, batch_id, device_id, supplier, status, created_at, created_by)
         VALUES (?, ?, ?, NULL, 'open', ?, ?)`
      )
      .run(
        skuId,
        batch.body.id,
        device.body.id,
        harness.clock.now().toISOString(),
        tech.user.id
      ).lastInsertRowid
  );
  return { demandId, batchId: batch.body.id as number, deviceId: device.body.id as number };
}

describe("PO labels and receiving (ticket 08)", () => {
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

  it("pre-assigns expected serials on approval and exposes them on labels", async () => {
    const skuId = await createSku(tech.agent, "Screen A");
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 3, unitPrice: "25.00" },
    ]);

    expect(po.status).toBe("In-transit");
    expect(po.expectedSerials).toHaveLength(3);
    expect(po.expectedSerials.every((entry) => !entry.received)).toBe(true);
    expect(po.expectedSerials.map((entry) => entry.serial)).toEqual([
      "P00001",
      "P00002",
      "P00003",
    ]);
    expect(po.events.some((event) => event.action === "po.serials_assigned")).toBe(true);

    const labels = await tech.agent.get(`/api/purchase-orders/${po.id}/labels`);
    expect(labels.status).toBe(200);
    // Default stock from settings: 37/16" × 64/16" = 2-5/16" × 4".
    expect(labels.body.label).toMatchObject({
      widthSixteenths: 37,
      heightSixteenths: 64,
      widthIn: 2.3125,
      heightIn: 4,
    });
    expect(labels.body.labels).toHaveLength(3);
    expect(labels.body.labels[0]).toMatchObject({
      serial: "P00001",
      skuId,
      skuName: "Screen A",
      received: false,
    });

    // Claims reserved the ids — ad-hoc intake must not collide.
    const intake = await tech.agent
      .post(`/api/skus/${skuId}/parts`)
      .send({ source: "migration", quantity: 1, counted: false });
    expect(intake.status).toBe(201);
    expect(intake.body.parts[0].serial).toBe("P00004");
  });

  it("sizes labels from the manager-editable label stock settings", async () => {
    const skuId = await createSku(tech.agent, "Screen B");
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "5.00" },
    ]);

    const refused = await tech.agent
      .patch("/api/settings")
      .send({ key: "label_width_sixteenths", value: 32 });
    expect(refused.status).toBe(403);

    const patched = await manager.agent
      .patch("/api/settings")
      .send({ key: "label_width_sixteenths", value: 32 });
    expect(patched.status).toBe(200);

    // The 2" × 1" target stock: 32/16" × 16/16".
    await manager.agent.patch("/api/settings").send({ key: "label_height_sixteenths", value: 16 });
    const labels = await tech.agent.get(`/api/purchase-orders/${po.id}/labels`);
    expect(labels.status).toBe(200);
    expect(labels.body.label).toMatchObject({ widthIn: 2, heightIn: 1 });
  });

  it("rejects unknown and already-received serials with clear messages", async () => {
    const skuId = await createSku(tech.agent, "Battery");
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "12.00" },
    ]);
    const serial = po.expectedSerials[0].serial;

    const unknown = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: "P99999" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/unknown serial/i);

    const first = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial });
    expect(first.status).toBe(200);

    const again = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already received/i);
  });

  it("computes Partially received then Received from scan counts", async () => {
    const skuId = await createSku(tech.agent, "Camera");
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 2, unitPrice: "40.00" },
    ]);

    const first = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("Partially received");
    expect(first.body.purchaseOrder.status).toBe("Partially received");
    expect(first.body.purchaseOrder.lines[0].receivedQuantity).toBe(1);
    expect(first.body.purchaseOrder.lines[0].shortfall).toBe(1);

    const part = await tech.agent.get(
      `/api/parts/${encodeURIComponent(po.expectedSerials[0].serial)}`
    );
    expect(part.status).toBe(200);
    expect(part.body.status).toBe("available");

    const second = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[1].serial });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("Received");
    expect(second.body.purchaseOrder.lines[0].receivedQuantity).toBe(2);
    expect(second.body.purchaseOrder.shortfallTotal).toBe(0);
  });

  it("refreshes the SKU price to the received unit cost", async () => {
    const skuId = await createSku(tech.agent, "Digitizer", "9.00");
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "15.50" },
    ]);

    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    expect(received.status).toBe(200);
    expect(received.body.priceChanged).toBe(true);

    const sku = await tech.agent.get(`/api/skus/${skuId}`);
    expect(sku.status).toBe(200);
    expect(sku.body.priceCents).toBe(1550);
    expect(sku.body.events.some((event: { action: string }) => event.action === "sku.price_changed")).toBe(
      true
    );
  });

  it("auto-reserves a received part to outstanding demand and fulfills it", async () => {
    const skuId = await createSku(tech.agent, "LCD", "20.00");
    const { demandId, deviceId } = await seedDemandWithDevice(harness, tech, skuId);
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "22.00", demandId },
    ]);

    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    expect(received.status).toBe(200);
    expect(received.body.reserved).toBe(true);
    expect(received.body.demandId).toBe(demandId);
    expect(received.body.deviceId).toBe(deviceId);

    const part = await tech.agent.get(
      `/api/parts/${encodeURIComponent(po.expectedSerials[0].serial)}`
    );
    expect(part.status).toBe(200);
    expect(part.body.status).toBe("reserved");

    const demand = harness.db
      .prepare("SELECT status, fulfilled_by FROM demand_records WHERE id = ?")
      .get(demandId) as { status: string; fulfilled_by: number };
    expect(demand.status).toBe("fulfilled");
    expect(demand.fulfilled_by).toBe(tech.user.id);

    const attachment = harness.db
      .prepare(
        "SELECT device_id, part_id, price_cents FROM device_parts WHERE device_id = ? AND removed_at IS NULL"
      )
      .get(deviceId) as { device_id: number; part_id: number; price_cents: number };
    expect(attachment.part_id).toBe(received.body.partId);
    expect(attachment.price_cents).toBe(2200);
  });

  it("honors the purchase_order_demand link: the line's demand is fulfilled first", async () => {
    const skuId = await createSku(tech.agent, "OLED", "30.00");
    // Two open demands for the same SKU on different batches/devices; the PO
    // line is created FROM the FIRST one, so the receipt must fulfill that
    // one (the link), not whichever happens to be oldest/open.
    const first = await seedDemandWithDevice(harness, tech, skuId, "356938035643809");
    const second = await seedDemandWithDevice(harness, tech, skuId, "354839092377642");
    expect(first.demandId).toBeLessThan(second.demandId);

    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "30.00", demandId: second.demandId },
    ]);

    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    expect(received.status).toBe(200);
    expect(received.body.demandId).toBe(second.demandId);
    expect(received.body.deviceId).toBe(second.deviceId);

    const statuses = harness.db
      .prepare("SELECT id, status FROM demand_records ORDER BY id")
      .all() as Array<{ id: number; status: string }>;
    expect(statuses).toEqual([
      { id: first.demandId, status: "open" },
      { id: second.demandId, status: "fulfilled" },
    ]);
  });

  it("auto-reserves against an unlinked open demand when the line has none", async () => {
    const skuId = await createSku(tech.agent, "Charging IC", "8.00");
    const { demandId, deviceId } = await seedDemandWithDevice(harness, tech, skuId);
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "8.00" },
    ]);

    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    expect(received.status).toBe(200);
    expect(received.body.reserved).toBe(true);
    expect(received.body.demandId).toBe(demandId);
    expect(received.body.deviceId).toBe(deviceId);
  });

  it("closes a PO with shortfall via required note and keeps shortfall visible", async () => {
    const skuId = await createSku(tech.agent, "Flex cable");
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 3, unitPrice: "5.00" },
    ]);

    await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });

    const missingNote = await tech.agent.post(`/api/purchase-orders/${po.id}/close`).send({});
    expect(missingNote.status).toBe(400);

    const closed = await tech.agent
      .post(`/api/purchase-orders/${po.id}/close`)
      .send({ note: "Vendor will not backorder the rest" });
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe("Closed");
    expect(closed.body.closedNote).toBe("Vendor will not backorder the rest");
    expect(closed.body.shortfallTotal).toBe(2);
    expect(closed.body.lines[0].shortfall).toBe(2);
    expect(closed.body.lines[0].receivedQuantity).toBe(1);

    const afterClose = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[1].serial });
    expect(afterClose.status).toBe(409);
  });

  it("releases the PO's still-open demands back to the outstanding queue on shortfall close", async () => {
    const skuId = await createSku(tech.agent, "Home Button", "6.00");
    // Two open demands for the same SKU, both linked to ONE line: the
    // receipt fulfills the line's first demand; the second is still open
    // when the PO closes short.
    const first = await seedDemandWithDevice(harness, tech, skuId, "356938035643809");
    const second = await seedDemandWithDevice(harness, tech, skuId, "354839092377642");
    const created = await tech.agent.post("/api/purchase-orders").send({
      purpose: "Shortfall release test",
      note: "Opening note",
      lines: [
        { skuId, quantity: 2, unitPrice: "6.00", demandIds: [first.demandId, second.demandId] },
      ],
    });
    expect(created.status).toBe(201);
    const approved = await manager.agent
      .post(`/api/purchase-orders/${created.body.id}/approve`)
      .send({ note: "Approved" });
    expect(approved.status).toBe(200);

    const received = await tech.agent
      .post(`/api/purchase-orders/${created.body.id}/receive`)
      .send({ serial: (approved.body as PoDetail).expectedSerials[0].serial });
    expect(received.status).toBe(200);
    expect(received.body.demandId).toBe(first.demandId);

    const closed = await tech.agent
      .post(`/api/purchase-orders/${created.body.id}/close`)
      .send({ note: "Vendor will not ship the second unit" });
    expect(closed.status).toBe(200);

    // The still-open demand is back on BOTH outstanding queues, unmarked.
    const poQueue = await tech.agent.get("/api/purchase-orders/demand");
    expect(poQueue.status).toBe(200);
    const group = (poQueue.body as { demand: Array<{ skuId: number; demandIds: number[] }> }).demand.find(
      (entry) => entry.skuId === skuId
    );
    expect(group?.demandIds).toEqual([second.demandId]);

    const globalQueue = await tech.agent.get("/api/demand");
    const rows = (globalQueue.body as { demand: Array<{ id: number; orderedOn: unknown }> }).demand;
    const released = rows.find((demand) => demand.id === second.demandId);
    expect(released?.orderedOn).toBeNull();
    // The fulfilled demand stays settled history — release must not resurrect it.
    expect(rows.find((demand) => demand.id === first.demandId)).toBeUndefined();

    // The links are gone; the close event names what it released.
    const links = harness.db
      .prepare("SELECT COUNT(*) AS n FROM purchase_order_demand WHERE po_id = ?")
      .get(created.body.id) as { n: number };
    expect(links.n).toBe(0);

    const detail = await tech.agent.get(`/api/purchase-orders/${created.body.id}`);
    const closeEvents = (detail.body as PoDetail).events.filter(
      (event) =>
        event.action === "po.status_changed" &&
        (event.payload as { to?: string } | null)?.to === "Closed"
    );
    expect(closeEvents).toHaveLength(1);
    expect((closeEvents[0].payload as { demandReleased?: number[] }).demandReleased).toEqual([
      second.demandId,
    ]);
  });

  it("refuses labels while still Awaiting approval", async () => {
    const skuId = await createSku(tech.agent, "Speaker");
    const created = await tech.agent.post("/api/purchase-orders").send({
      purpose: "Not yet approved",
      note: "wait",
      lines: [{ skuId, quantity: 1, unitPrice: "8.00" }],
    });
    expect(created.status).toBe(201);
    const labels = await tech.agent.get(`/api/purchase-orders/${created.body.id}/labels`);
    expect(labels.status).toBe(409);
  });
});

describe("auto-reserve hardening (ticket 09)", () => {
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

  function approvedCostCents(batchId: number): number {
    return (
      harness.db
        .prepare("SELECT approved_cost_cents FROM batches WHERE id = ?")
        .get(batchId) as { approved_cost_cents: number }
    ).approved_cost_cents;
  }

  function amendmentEvents(batchId: number): Array<{ previousTotalCents: number; totalCents: number; note: string }> {
    return (
      harness.db
        .prepare(
          `SELECT payload FROM events
            WHERE entity_type = 'batch' AND entity_id = ? AND action = 'batch.approval_amended'
            ORDER BY id`
        )
        .all(batchId) as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload));
  }

  it("amends the approval UP to the part's actual price, with the PO receipt as the recorded cause", async () => {
    const skuId = await createSku(tech.agent, "LCD", "20.00");
    const { demandId, batchId, deviceId } = await seedDemandWithDevice(harness, tech, skuId);
    // Approval signed off at 0 (the NTO demand is an estimate, excluded per
    // spec decision 7); the arrival makes the cost real.
    expect(approvedCostCents(batchId)).toBe(0);
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "22.00", demandId },
    ]);

    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    expect(received.status).toBe(200);
    expect(received.body.reserved).toBe(true);
    expect(received.body.reservationRefusal).toBeNull();

    // The approved cost reflects the part's actual price immediately.
    expect(approvedCostCents(batchId)).toBe(2200);
    const amendments = amendmentEvents(batchId);
    expect(amendments).toHaveLength(1);
    expect(amendments[0]).toMatchObject({ previousTotalCents: 0, totalCents: 2200 });
    // The amendment's note names the PO receipt as the cause.
    expect(amendments[0].note).toMatch(/purchase order #\d+/);
    // The reservation events carry the cause and the receipt source too.
    const deviceEvent = harness.db
      .prepare(
        `SELECT payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.part_reserved'`
      )
      .get(deviceId) as { payload: string };
    expect(JSON.parse(deviceEvent.payload)).toMatchObject({
      priceCents: 2200,
      demandId,
      source: "po_receive",
    });
  });

  it("amends to the ACTUAL price when the unit costs less than the SKU-price estimate (no estimate baked in)", async () => {
    // The demand's estimate is the SKU price ($50.00); the actual unit cost
    // on the PO line is $20.00. The amendment moves the approved total by
    // the actual price only — never the higher estimate.
    const skuId = await createSku(tech.agent, "OLED", "50.00");
    const { demandId, batchId } = await seedDemandWithDevice(harness, tech, skuId);
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "20.00", demandId },
    ]);

    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    expect(received.status).toBe(200);
    expect(received.body.reserved).toBe(true);
    expect(approvedCostCents(batchId)).toBe(2000);
  });

  it("does not apply the Price Add Limit — the demand is the approval-time intent", async () => {
    const skuId = await createSku(tech.agent, "Charging IC", "8.00");
    const { demandId, batchId, deviceId } = await seedDemandWithDevice(harness, tech, skuId);
    // An interactive tech add of this part would be refused outright at
    // limit 0 (spend 0 + 800 > 0); the manager pins the limit at 0 to prove
    // the receipt path is exempt, not merely under an open limit.
    const pinned = await manager.agent
      .patch(`/api/batches/${batchId}/devices/${deviceId}/price-limit`)
      .send({ priceAddLimitCents: 0, note: "no post-approval spend" });
    expect(pinned.status).toBe(200);

    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "8.00", demandId },
    ]);
    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    expect(received.status).toBe(200);
    expect(received.body.reserved).toBe(true);
    expect(approvedCostCents(batchId)).toBe(800);
  });

  it("refuses the reservation on a Closed batch — the receipt still completes and the demand stays open", async () => {
    const skuId = await createSku(tech.agent, "Battery", "30.00");
    const { demandId, batchId, deviceId } = await seedDemandWithDevice(harness, tech, skuId);
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "30.00", demandId },
    ]);

    // Close the batch while the demand is still open and the PO in transit:
    // the device goes terminal (close requires every device terminal) and
    // the batch closes with the need unresolved.
    await tech.agent.post(`/api/batches/${batchId}/devices/${deviceId}/status`).send({
      repairStatus: "In progress",
    });
    await tech.agent.post(`/api/batches/${batchId}/devices/${deviceId}/status`).send({
      repairStatus: "Repaired",
      resolutionNotes: "shipped without the part",
    });
    const closed = await tech.agent.post(`/api/batches/${batchId}/close`).send({});
    expect(closed.status).toBe(200);

    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    // The part receipt itself completes — the arrival is a physical fact.
    expect(received.status).toBe(200);
    expect(received.body.reserved).toBe(false);
    expect(received.body.reservationRefusal).toMatch(/Closed/);
    expect(received.body.demandId).toBe(demandId);
    expect(received.body.purchaseOrder.lines[0].receivedQuantity).toBe(1);

    // The unit stays Available (nothing was attached), the demand stays OPEN
    // for manual resolution, and no amendment happened.
    const part = await tech.agent.get(
      `/api/parts/${encodeURIComponent(po.expectedSerials[0].serial)}`
    );
    expect(part.body.status).toBe("available");
    const demand = harness.db
      .prepare("SELECT status FROM demand_records WHERE id = ?")
      .get(demandId) as { status: string };
    expect(demand.status).toBe("open");
    const attachments = harness.db
      .prepare("SELECT COUNT(*) AS n FROM device_parts WHERE part_id = ?")
      .get(received.body.partId) as { n: number };
    expect(attachments.n).toBe(0);
    expect(amendmentEvents(batchId)).toHaveLength(0);

    // Loud, not silent: the refusal is on the PO's timeline.
    const detail = (await tech.agent.get(`/api/purchase-orders/${po.id}`)).body as PoDetail;
    const receivedPayload = detail.events.find(
      (event) => event.action === "po.part_received"
    )?.payload;
    expect(receivedPayload).toMatchObject({ reserved: false, demandId });
    expect((receivedPayload as { reservationRefusal: string }).reservationRefusal).toMatch(
      /Closed/
    );
  });
});

describe("fulfillment auto-unblocks a Parts-needed device", () => {
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

  function repairStatus(deviceId: number): string {
    return (
      harness.db
        .prepare("SELECT repair_status FROM devices WHERE id = ?")
        .get(deviceId) as { repair_status: string }
    ).repair_status;
  }

  function statusChanges(deviceId: number): Array<Record<string, unknown>> {
    return (
      harness.db
        .prepare(
          `SELECT payload FROM events
            WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.status_changed'
            ORDER BY id`
        )
        .all(deviceId) as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload));
  }

  /** Test-setup convenience (as with the demand rows above): park the device
   * in Parts needed the way the attach path's auto-move leaves it. */
  function parkInPartsNeeded(deviceId: number): void {
    harness.db
      .prepare("UPDATE devices SET repair_status = 'Parts needed' WHERE id = ?")
      .run(deviceId);
  }

  it("a fulfilled demand auto-returns the device to Awaiting repair", async () => {
    const skuId = await createSku(tech.agent, "LCD", "20.00");
    const { demandId, deviceId } = await seedDemandWithDevice(harness, tech, skuId);
    parkInPartsNeeded(deviceId);
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "20.00", demandId },
    ]);

    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    expect(received.status).toBe(200);
    expect(received.body.reserved).toBe(true);
    expect(received.body.demandId).toBe(demandId);

    expect(repairStatus(deviceId)).toBe("Awaiting repair");
    // The move is evented through setRepairStatus like any status change,
    // with the fulfillment as its reason.
    const move = statusChanges(deviceId).find((payload) => payload.to === "Awaiting repair");
    expect(move).toMatchObject({
      from: "Parts needed",
      to: "Awaiting repair",
      reason: "need fulfilled",
    });
  });

  it("the device stays blocked while another open need remains, and unblocks when the LAST one fills", async () => {
    const screen = await createSku(tech.agent, "Screen", "20.00");
    const battery = await createSku(tech.agent, "Battery", "30.00");
    const { batchId, deviceId } = await seedDemandWithDevice(harness, tech, screen);
    parkInPartsNeeded(deviceId);
    // A second open need on the SAME device (a different SKU).
    const batteryDemandId = Number(
      harness.db
        .prepare(
          `INSERT INTO demand_records (sku_id, batch_id, device_id, supplier, status, created_at, created_by)
           VALUES (?, ?, ?, NULL, 'open', ?, ?)`
        )
        .run(
          battery,
          batchId,
          deviceId,
          harness.clock.now().toISOString(),
          tech.user.id
        ).lastInsertRowid
    );

    // The battery arrives: one need filled, the device is still blocked.
    const batteryPo = await createApprovedPo(tech.agent, manager.agent, [
      { skuId: battery, quantity: 1, unitPrice: "30.00" },
    ]);
    const first = await tech.agent
      .post(`/api/purchase-orders/${batteryPo.id}/receive`)
      .send({ serial: batteryPo.expectedSerials[0].serial });
    expect(first.status).toBe(200);
    expect(first.body.demandId).toBe(batteryDemandId);
    expect(repairStatus(deviceId)).toBe("Parts needed");

    // The screen arrives: the last open need is gone — the device unblocks.
    const screenPo = await createApprovedPo(tech.agent, manager.agent, [
      { skuId: screen, quantity: 1, unitPrice: "20.00" },
    ]);
    const second = await tech.agent
      .post(`/api/purchase-orders/${screenPo.id}/receive`)
      .send({ serial: screenPo.expectedSerials[0].serial });
    expect(second.status).toBe(200);
    expect(repairStatus(deviceId)).toBe("Awaiting repair");
  });

  it("a device pulled back to work is not rewound by the arrival", async () => {
    const skuId = await createSku(tech.agent, "LCD", "20.00");
    const { demandId, deviceId } = await seedDemandWithDevice(harness, tech, skuId);
    parkInPartsNeeded(deviceId);
    // The tech pulled the device back onto the bench while the part traveled.
    harness.db
      .prepare("UPDATE devices SET repair_status = 'In progress' WHERE id = ?")
      .run(deviceId);
    const po = await createApprovedPo(tech.agent, manager.agent, [
      { skuId, quantity: 1, unitPrice: "20.00", demandId },
    ]);

    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial: po.expectedSerials[0].serial });
    expect(received.status).toBe(200);
    expect(received.body.reserved).toBe(true);

    // Still In progress: the auto-unblock only ever lifts a Parts-needed
    // block, never rewinds a device someone is working on.
    expect(repairStatus(deviceId)).toBe("In progress");
    expect(statusChanges(deviceId).filter((payload) => payload.reason === "need fulfilled")).toHaveLength(0);
  });
});
