import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";
import { countPartsByIntakeSource } from "../domains/parts/intake.js";

/**
 * Ticket 13 — intake outside purchase orders: salvage (one part, required
 * provenance note) and migration (bulk add, "physically counted now"
 * confirmation), the intake source stamped on every part (including
 * PO-received parts), the counted-baseline rule against the audits domain,
 * and the shared label-sheet data endpoint.
 */

const MANAGER = DEFAULT_MANAGER_EMAIL;
const DAY_MS = 24 * 60 * 60 * 1000;
type Agent = LoggedInAgent["agent"];

interface PartBody {
  id: number;
  skuId: number;
  serial: string;
  status: string;
  statusLabel: string;
  lastCountedAt: string | null;
  createdAt: string;
  intakeSource: string;
}

interface IntakeResponse {
  parts: PartBody[];
}

async function createSku(
  agent: Agent,
  overrides: Record<string, unknown> = {},
): Promise<{ id: number; kind: string; name: string }> {
  const response = await agent.post("/api/skus").send({
    name: "iPhone 13 Screen",
    price: "109.99",
    kind: "serialized",
    ...overrides,
  });
  expect(response.status).toBe(201);
  return response.body as { id: number; kind: string; name: string };
}

async function intake(agent: Agent, skuId: number, body: Record<string, unknown>) {
  return agent.post(`/api/skus/${skuId}/parts`).send(body);
}

describe("salvage intake (ticket 13)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("adds exactly one part with source=salvage and the required provenance note on the part and its timeline", async () => {
    const sku = await createSku(tech.agent);
    const response = await intake(tech.agent, sku.id, {
      source: "salvage",
      note: "Came off trade-in iPhone 12 — screen survived, digitizer spare",
    });
    expect(response.status).toBe(201);
    const body = response.body as IntakeResponse;
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0]).toMatchObject({
      status: "available",
      intakeSource: "salvage",
      lastCountedAt: null, // salvage has no counted confirmation — the first audit will demand it
    });

    const row = harness.db
      .prepare("SELECT intake_source, status, last_counted_at FROM serialized_parts WHERE id = ?")
      .get(body.parts[0].id) as {
      intake_source: string;
      status: string;
      last_counted_at: string | null;
    };
    expect(row).toEqual({
      intake_source: "salvage",
      status: "available",
      last_counted_at: null,
    });

    const event = harness.db
      .prepare("SELECT action, payload FROM events WHERE entity_type = 'part' AND entity_id = ?")
      .get(body.parts[0].id) as { action: string; payload: string };
    expect(event.action).toBe("part.added");
    expect(JSON.parse(event.payload)).toEqual({
      serial: body.parts[0].serial,
      source: "salvage",
      note: "Came off trade-in iPhone 12 — screen survived, digitizer spare",
    });

    // The one timeline read seam shows the provenance on the part's history.
    const detail = await tech.agent.get(`/api/parts/${body.parts[0].serial}`);
    expect(detail.status).toBe(200);
    const added = (detail.body.events as Array<{ action: string; payload: Record<string, unknown> }>).find(
      (event) => event.action === "part.added"
    );
    expect(added?.payload).toMatchObject({ source: "salvage" });
  });

  it("refuses salvage without a provenance note — the story is the point of salvage", async () => {
    const sku = await createSku(tech.agent);
    for (const body of [{ source: "salvage" }, { source: "salvage", note: "" }, { source: "salvage", note: "   " }]) {
      const response = await intake(tech.agent, sku.id, body);
      expect(response.status).toBe(400);
    }
    const count = harness.db
      .prepare("SELECT COUNT(*) AS n FROM serialized_parts")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("refuses salvage with a quantity — bulk goes through migration intake", async () => {
    const sku = await createSku(tech.agent);
    const response = await intake(tech.agent, sku.id, { source: "salvage", quantity: 3, note: "bulk salvage" });
    expect(response.status).toBe(400);
  });

  it("refuses salvage on a consumable SKU — consumables are cost-only", async () => {
    const sku = await createSku(tech.agent, { name: "Adhesive strips", kind: "consumable", price: "1.50" });
    const response = await intake(tech.agent, sku.id, { source: "salvage", note: "leftover roll" });
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toMatch(/consumable/);
  });
});

describe("migration intake (ticket 13)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("adds N parts in one action with source=migration", async () => {
    const sku = await createSku(tech.agent);
    const response = await intake(tech.agent, sku.id, { source: "migration", quantity: 5, counted: false });
    expect(response.status).toBe(201);
    const body = response.body as IntakeResponse;
    expect(body.parts).toHaveLength(5);
    expect(body.parts.every((part) => part.intakeSource === "migration")).toBe(true);
    const count = harness.db
      .prepare("SELECT COUNT(*) AS n FROM serialized_parts WHERE sku_id = ? AND intake_source = 'migration'")
      .get(sku.id) as { n: number };
    expect(count.n).toBe(5);
  });

  it("sets last-counted through the cycle-count mechanism when the tech confirms a physical count", async () => {
    const sku = await createSku(tech.agent);
    const response = await intake(tech.agent, sku.id, { source: "migration", quantity: 2, counted: true });
    const body = response.body as IntakeResponse;
    const now = harness.clock.now().toISOString();
    for (const part of body.parts) {
      expect(part.lastCountedAt).toBe(now);
      const row = harness.db
        .prepare("SELECT last_counted_at FROM serialized_parts WHERE id = ?")
        .get(part.id) as { last_counted_at: string };
      expect(row.last_counted_at).toBe(now);
    }
    // The counted event comes from the shared counting seam (audits/counting.ts) — same shape a cycle count records.
    const counted = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'part' AND entity_id = ? AND action = 'part.counted'"
      )
      .all(body.parts[0].id) as Array<{ payload: string }>;
    expect(counted).toHaveLength(1);
    expect(JSON.parse(counted[0].payload)).toMatchObject({ context: "migration_intake" });
  });

  it("leaves unconfirmed migration parts uncounted — the first audit will demand them", async () => {
    const sku = await createSku(tech.agent);
    const response = await intake(tech.agent, sku.id, { source: "migration", quantity: 2, counted: false });
    const body = response.body as IntakeResponse;
    for (const part of body.parts) {
      expect(part.lastCountedAt).toBeNull();
    }
    const counted = harness.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE entity_type = 'part' AND entity_id = ? AND action = 'part.counted'"
      )
      .get(body.parts[0].id) as { n: number };
    expect(counted.n).toBe(0);
  });

  it("requires the counted confirmation explicitly — no silent default for a domain rule", async () => {
    const sku = await createSku(tech.agent);
    const response = await intake(tech.agent, sku.id, { source: "migration", quantity: 1 });
    expect(response.status).toBe(400);
  });

  it("keeps the bulk bounds — quantity must be a whole number between 1 and 200", async () => {
    const sku = await createSku(tech.agent);
    for (const quantity of [0, 201, 2.5]) {
      const response = await intake(tech.agent, sku.id, { source: "migration", quantity, counted: true });
      expect(response.status).toBe(400);
    }
  });
});

describe("counted-baseline rule against audits (ticket 13)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;
  let manager: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
    // Ticket 02: only a manager may open a window (the bootstrap), so the
    // audit windows in these tests are opened by the manager while the tech
    // does the intake work under test.
    manager = await harness.loginAs(MANAGER);
  });

  afterEach(() => {
    harness.close();
  });

  it("a counted migration is a real count: the next audit does not demand those parts, an unconfirmed one does", async () => {
    const sku = await createSku(tech.agent);

    // Audit #1 establishes the baseline (everything on the shelf is due).
    const first = await manager.agent.post("/api/audits").send({});
    expect(first.status).toBe(201);
    // Ticket 03: closing is manager-gated, so the manager closes the
    // baseline window; the tech only does the intake work under test.
    const closed = await manager.agent.post(`/api/audits/${first.body.id}/close`).send({});
    expect(closed.status).toBe(200);

    // Migrate: two parts counted now (last-counted = now), then a separate
    // migration batch left unconfirmed (last-counted stays NULL).
    harness.clock.advance(3 * DAY_MS);
    const response = await intake(tech.agent, sku.id, { source: "migration", quantity: 4, counted: true });
    const countedSerial = (response.body as IntakeResponse).parts[0].serial;
    const unconfirmed = await intake(tech.agent, sku.id, { source: "migration", quantity: 1, counted: false });
    const unconfirmedSerial = (unconfirmed.body as IntakeResponse).parts[0].serial;

    // Ticket 02: the next window opens ITSELF at the boundary (the first
    // audit's open date + the 2-month interval) — the status poll below is
    // the lazy trigger; no manual second window exists any more.
    harness.clock.advance(62 * DAY_MS);
    const status = await manager.agent.get("/api/audits/status");
    expect(status.body.openAuditId).not.toBeNull();
    const second = await manager.agent.get(`/api/audits/${status.body.openAuditId}`);
    expect(second.status).toBe(200);
    const due: Array<{ serial: string }> = second.body.parts.due;
    expect(due.map((part) => part.serial)).toEqual([unconfirmedSerial]);

    // The counted-migrated part is exempt with the recently-counted reason.
    const exempt: Array<{ serial: string; reason: string }> = second.body.parts.exempt;
    const entry = exempt.find((part) => part.serial === countedSerial);
    expect(entry?.reason).toBe("recently-counted");
  });

  it("a part intake'd while a window is open is added-since-open — exempt, and never failed at close", async () => {
    const sku = await createSku(tech.agent);
    const open = await manager.agent.post("/api/audits").send({});
    expect(open.status).toBe(201);

    harness.clock.advance(60 * 60 * 1000);
    const salvaged = await intake(tech.agent, sku.id, { source: "salvage", note: "off a donor board" });
    const migrated = await intake(tech.agent, sku.id, { source: "migration", quantity: 2, counted: true });
    const serials = [
      (salvaged.body as IntakeResponse).parts[0].serial,
      ...(migrated.body as IntakeResponse).parts.map((part) => part.serial),
    ];

    const detail = await tech.agent.get(`/api/audits/${open.body.id}`);
    const exempt: Array<{ serial: string; reason: string }> = detail.body.parts.exempt;
    for (const serial of serials) {
      const entry = exempt.find((part) => part.serial === serial);
      expect(entry?.reason).toBe("added-since-open");
    }

    const closed = await manager.agent.post(`/api/audits/${open.body.id}/close`).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.summary.failed).toBe(0);
    for (const serial of serials) {
      const part = await tech.agent.get(`/api/parts/${serial}`);
      expect(part.body.status).toBe("available");
    }
  });
});

describe("PO receiving stamps purchase-order intake source (ticket 13)", () => {
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

  it("a received part carries intake_source='purchase-order' on the row and its part.added event", async () => {
    const sku = await createSku(tech.agent, { name: "PO Screen" });
    const created = await tech.agent.post("/api/purchase-orders").send({
      purpose: "stamp test",
      note: "opening note",
      lines: [{ skuId: sku.id, quantity: 1, unitPrice: "25.00" }],
    });
    expect(created.status).toBe(201);
    const approved = await manager.agent
      .post(`/api/purchase-orders/${created.body.id}/approve`)
      .send({ note: "approve" });
    expect(approved.status).toBe(200);
    const serial = approved.body.expectedSerials[0].serial as string;
    const received = await tech.agent.post(`/api/purchase-orders/${created.body.id}/receive`).send({ serial });
    expect(received.status).toBe(200);

    const partId = received.body.partId as number;
    const row = harness.db
      .prepare("SELECT intake_source FROM serialized_parts WHERE id = ?")
      .get(partId) as { intake_source: string };
    expect(row.intake_source).toBe("purchase-order");

    const event = harness.db
      .prepare("SELECT payload FROM events WHERE entity_type = 'part' AND entity_id = ? AND action = 'part.added'")
      .get(partId) as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ intakeSource: "purchase-order" });
  });
});

describe("part label data endpoint (ticket 13)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("returns label data for any set of parts, sized from the configured label stock", async () => {
    const sku = await createSku(tech.agent, { name: "Label Screen" });
    const intake1 = await intake(tech.agent, sku.id, { source: "migration", quantity: 2, counted: true });
    const intake2 = await intake(tech.agent, sku.id, { source: "salvage", note: "donor board" });
    const ids = [
      ...(intake1.body as IntakeResponse).parts.map((part) => part.id),
      ...(intake2.body as IntakeResponse).parts.map((part) => part.id),
    ];

    const response = await tech.agent.get(`/api/parts/labels?ids=${ids.join(",")}`);
    expect(response.status).toBe(200);
    expect(response.body.label).toEqual({
      widthSixteenths: 37,
      heightSixteenths: 64,
      widthIn: 37 / 16,
      heightIn: 64 / 16,
    });
    expect(response.body.labels).toHaveLength(3);
    expect(response.body.labels[0]).toMatchObject({
      id: ids[0],
      serial: expect.stringMatching(/^P\d{5}$/),
      skuId: sku.id,
      skuName: "Label Screen",
    });
  });

  it("uses the manager-configured label size, not a hardcoded one", async () => {
    const manager = await harness.createUserAs("manager2@acme.co", "manager");
    const sku = await createSku(tech.agent);
    const created = await intake(tech.agent, sku.id, { source: "migration", quantity: 1, counted: false });
    const id = (created.body as IntakeResponse).parts[0].id;
    const patched = await manager.agent
      .patch("/api/settings")
      .send({ key: "label_height_sixteenths", value: "16" });
    expect(patched.status).toBe(200);

    const response = await tech.agent.get(`/api/parts/labels?ids=${id}`);
    expect(response.body.label).toEqual({
      widthSixteenths: 37,
      heightSixteenths: 16,
      widthIn: 37 / 16,
      heightIn: 1,
    });
  });

  it("refuses missing ids loudly and unknown ids with 404", async () => {
    const missing = await tech.agent.get("/api/parts/labels");
    expect(missing.status).toBe(400);
    const unknown = await tech.agent.get("/api/parts/labels?ids=99999");
    expect(unknown.status).toBe(404);
  });
});

describe("intake source aggregation (ticket 13, consumed by the expense report)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("counts parts by intake source with a plain GROUP BY", async () => {
    const sku = await createSku(tech.agent);
    await intake(tech.agent, sku.id, { source: "migration", quantity: 3, counted: false });
    await intake(tech.agent, sku.id, { source: "salvage", note: "donor" });
    expect(countPartsByIntakeSource(harness.db)).toEqual({
      migration: 3,
      salvage: 1,
    });
  });

  it("the migrated table leaves no NULL intake sources behind", async () => {
    const sku = await createSku(tech.agent);
    await intake(tech.agent, sku.id, { source: "migration", quantity: 2, counted: true });
    const nulls = harness.db
      .prepare("SELECT COUNT(*) AS n FROM serialized_parts WHERE intake_source IS NULL")
      .get() as { n: number };
    expect(nulls.n).toBe(0);
  });
});

describe("intake auto-reserve onto outstanding demand (ticket 10)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  interface ArrivalPart extends PartBody {
    reserved: boolean;
    reservationRefusal: string | null;
    demandId: number | null;
    batchId: number | null;
    batchNumber: number | null;
    deviceId: number | null;
    deviceLabel: string | null;
  }

  /**
   * A batch + device with an approved (Open) batch and one open demand for
   * the SKU — the same seeding the PO-receipt auto-reserve tests use. With
   * `approve: false` the batch stays Awaiting approval (a demand written
   * before the manager's sign-off).
   */
  async function seedDemand(
    skuId: number,
    imei = "356938035643809",
    approve = true
  ): Promise<{ demandId: number; batchId: number; deviceId: number }> {
    const batch = await tech.agent.post("/api/batches").send({ note: "blocked on parts" });
    expect(batch.status).toBe(201);
    const device = await tech.agent.post(`/api/batches/${batch.body.id}/devices`).send({
      modelName: "iPhone 12",
      imei,
      statedIssue: "cracked screen",
    });
    expect(device.status).toBe(201);
    if (approve) {
      const manager = await harness.loginAs(MANAGER);
      const decided = await manager.agent
        .post(`/api/batches/${batch.body.id}/devices/${device.body.id}/approval`)
        .send({ decision: "approved" });
      expect(decided.status).toBe(200);
      const approved = await manager.agent
        .post(`/api/batches/${batch.body.id}/approve`)
        .send({ note: "costs approved" });
      expect(approved.status).toBe(200);
    }
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

  function approvedCostCents(batchId: number): number {
    return (
      harness.db
        .prepare("SELECT approved_cost_cents FROM batches WHERE id = ?")
        .get(batchId) as { approved_cost_cents: number }
    ).approved_cost_cents;
  }

  it("salvaging one part with one open demand reserves it to the demanding device, fulfills the demand, and amends the approval", async () => {
    const sku = await createSku(tech.agent, { name: "iPhone 16 Screen", price: "20.00" });
    // Approval signed off at 0 (the NTO demand is an estimate, excluded per
    // spec decision 7); the intake arrival makes the cost real.
    const { demandId, batchId, deviceId } = await seedDemand(sku.id);
    expect(approvedCostCents(batchId)).toBe(0);

    const response = await intake(tech.agent, sku.id, {
      source: "salvage",
      note: "screen survived a trade-in donor",
    });
    expect(response.status).toBe(201);
    const part = (response.body as IntakeResponse).parts[0] as ArrivalPart;
    expect(part.reserved).toBe(true);
    expect(part.reservationRefusal).toBeNull();
    expect(part.demandId).toBe(demandId);
    expect(part.batchId).toBe(batchId);
    expect(part.deviceId).toBe(deviceId);
    // The confirmation names the batch and the device (model + best identifier).
    expect(typeof part.batchNumber).toBe("number");
    expect(part.deviceLabel).toMatch(/iPhone 12 \(356938035643809\)/);
    expect(part.status).toBe("reserved");

    const demand = harness.db
      .prepare("SELECT status, fulfilled_by FROM demand_records WHERE id = ?")
      .get(demandId) as { status: string; fulfilled_by: number };
    expect(demand.status).toBe("fulfilled");
    expect(demand.fulfilled_by).toBe(tech.user.id);

    // The attachment prices at the part's OWN price (no override → SKU price).
    const attachment = harness.db
      .prepare(
        "SELECT part_id, price_cents FROM device_parts WHERE device_id = ? AND removed_at IS NULL"
      )
      .get(deviceId) as { part_id: number; price_cents: number };
    expect(attachment.part_id).toBe(part.id);
    expect(attachment.price_cents).toBe(2000);

    // The approval follows the part's actual price, with the intake named
    // as the cause.
    expect(approvedCostCents(batchId)).toBe(2000);
    const amendments = amendmentEvents(batchId);
    expect(amendments).toHaveLength(1);
    expect(amendments[0]).toMatchObject({ previousTotalCents: 0, totalCents: 2000 });
    expect(amendments[0].note).toMatch(/salvage intake/);

    // The reservation events carry the intake as the arrival door.
    const deviceEvent = harness.db
      .prepare(
        `SELECT payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.part_reserved'`
      )
      .get(deviceId) as { payload: string };
    expect(JSON.parse(deviceEvent.payload)).toMatchObject({
      priceCents: 2000,
      demandId,
      source: "salvage",
    });
  });

  it("salvage prices the attachment at the part's OWN price override, and the approval amend follows it", async () => {
    const sku = await createSku(tech.agent, { name: "OLED", price: "20.00" });
    const { batchId, deviceId } = await seedDemand(sku.id);

    const response = await intake(tech.agent, sku.id, {
      source: "salvage",
      note: "eBay unit",
      price: "50.00",
    });
    expect(response.status).toBe(201);
    const part = (response.body as IntakeResponse).parts[0] as ArrivalPart;
    expect(part.reserved).toBe(true);

    const attachment = harness.db
      .prepare("SELECT price_cents FROM device_parts WHERE device_id = ? AND removed_at IS NULL")
      .get(deviceId) as { price_cents: number };
    expect(attachment.price_cents).toBe(5000);
    expect(approvedCostCents(batchId)).toBe(5000);
    expect(amendmentEvents(batchId)[0]).toMatchObject({ previousTotalCents: 0, totalCents: 5000 });
  });

  it("two parts with two demands on different batches go FIFO by demand age, both fulfilled correctly", async () => {
    const sku = await createSku(tech.agent, { name: "iPhone 13 Battery", price: "15.00" });
    // The outstanding queue is ordered by demand id — creation order, so the
    // first-seeded demand is the oldest.
    const first = await seedDemand(sku.id, "356938035643809");
    const second = await seedDemand(sku.id, "354839092377642");
    expect(first.demandId).toBeLessThan(second.demandId);

    const response = await intake(tech.agent, sku.id, {
      source: "migration",
      quantity: 2,
      counted: true,
    });
    expect(response.status).toBe(201);
    const parts = (response.body as IntakeResponse).parts as ArrivalPart[];
    expect(parts).toHaveLength(2);
    // One serialized part per demand unit, oldest first — and the result
    // records which batch/device received each part.
    expect(parts[0].demandId).toBe(first.demandId);
    expect(parts[0].deviceId).toBe(first.deviceId);
    expect(parts[1].demandId).toBe(second.demandId);
    expect(parts[1].deviceId).toBe(second.deviceId);
    for (const part of parts) {
      expect(part.reserved).toBe(true);
      expect(part.status).toBe("reserved");
    }

    const statuses = harness.db
      .prepare("SELECT id, status FROM demand_records ORDER BY id")
      .all() as Array<{ id: number; status: string }>;
    expect(statuses).toEqual([
      { id: first.demandId, status: "fulfilled" },
      { id: second.demandId, status: "fulfilled" },
    ]);

    const attachments = harness.db
      .prepare("SELECT device_id, part_id FROM device_parts WHERE removed_at IS NULL ORDER BY device_id")
      .all() as Array<{ device_id: number; part_id: number }>;
    expect(attachments).toEqual([
      { device_id: first.deviceId, part_id: parts[0].id },
      { device_id: second.deviceId, part_id: parts[1].id },
    ]);
  });

  it("salvage with no outstanding demand lands Available and nothing else happens", async () => {
    const sku = await createSku(tech.agent, { name: "Spare Screen", price: "10.00" });
    const response = await intake(tech.agent, sku.id, { source: "salvage", note: "donor board" });
    expect(response.status).toBe(201);
    const part = (response.body as IntakeResponse).parts[0] as ArrivalPart;
    expect(part.status).toBe("available");
    expect(part.reserved).toBe(false);
    expect(part.demandId).toBeNull();
    expect(part.reservationRefusal).toBeNull();

    const attachments = harness.db
      .prepare("SELECT COUNT(*) AS n FROM device_parts")
      .get() as { n: number };
    expect(attachments.n).toBe(0);
    const fulfilled = harness.db
      .prepare("SELECT COUNT(*) AS n FROM demand_records WHERE status = 'fulfilled'")
      .get() as { n: number };
    expect(fulfilled.n).toBe(0);
  });

  it("migration intake behaves identically to salvage: one part, one demand, reserved and fulfilled", async () => {
    const sku = await createSku(tech.agent, { name: "Charging IC", price: "8.00" });
    const { demandId, batchId, deviceId } = await seedDemand(sku.id);

    const response = await intake(tech.agent, sku.id, { source: "migration", quantity: 1, counted: true });
    expect(response.status).toBe(201);
    const part = (response.body as IntakeResponse).parts[0] as ArrivalPart;
    expect(part.reserved).toBe(true);
    expect(part.demandId).toBe(demandId);
    expect(part.deviceId).toBe(deviceId);
    expect(part.status).toBe("reserved");

    const demand = harness.db
      .prepare("SELECT status FROM demand_records WHERE id = ?")
      .get(demandId) as { status: string };
    expect(demand.status).toBe("fulfilled");
    expect(approvedCostCents(batchId)).toBe(800);
  });

  it("a Closed batch's still-open demand is not consumed by intake — the part stays Available and nothing attaches", async () => {
    // The outstanding-demand definition (batchparts/queries.ts
    // `listOutstandingDemand`) excludes Closed batches — its record is
    // finished — so intake never picks the demand and the seam's lifecycle
    // refusal is unreachable through this door by construction (it IS
    // reachable from PO receipt, which picks any open demand). This pins the
    // observable intake behavior: no attachment, no amendment, demand left
    // exactly as it was, part Available.
    const sku = await createSku(tech.agent, { name: "Battery", price: "30.00" });
    const { demandId, batchId, deviceId } = await seedDemand(sku.id);
    await tech.agent.post(`/api/batches/${batchId}/devices/${deviceId}/status`).send({
      repairStatus: "In progress",
    });
    await tech.agent.post(`/api/batches/${batchId}/devices/${deviceId}/status`).send({
      repairStatus: "Repaired",
      resolutionNotes: "shipped without the part",
    });
    const closed = await tech.agent.post(`/api/batches/${batchId}/close`).send({});
    expect(closed.status).toBe(200);

    const response = await intake(tech.agent, sku.id, { source: "salvage", note: "spare from donor" });
    expect(response.status).toBe(201);
    const part = (response.body as IntakeResponse).parts[0] as ArrivalPart;
    expect(part.status).toBe("available");
    expect(part.reserved).toBe(false);
    expect(part.reservationRefusal).toBeNull();

    const demand = harness.db
      .prepare("SELECT status FROM demand_records WHERE id = ?")
      .get(demandId) as { status: string };
    expect(demand.status).toBe("open");
    const attachments = harness.db
      .prepare("SELECT COUNT(*) AS n FROM device_parts")
      .get() as { n: number };
    expect(attachments.n).toBe(0);
    expect(amendmentEvents(batchId)).toHaveLength(0);
  });

  it("a demand on an Awaiting-approval batch is not outstanding — intake does not attach onto an unapproved batch", async () => {
    const sku = await createSku(tech.agent, { name: "Flex cable", price: "5.00" });
    const { demandId } = await seedDemand(sku.id, "356938035643809", false);

    const response = await intake(tech.agent, sku.id, { source: "salvage", note: "donor" });
    expect(response.status).toBe(201);
    const part = (response.body as IntakeResponse).parts[0] as ArrivalPart;
    expect(part.status).toBe("available");
    expect(part.reserved).toBe(false);

    const demand = harness.db
      .prepare("SELECT status FROM demand_records WHERE id = ?")
      .get(demandId) as { status: string };
    expect(demand.status).toBe("open");
  });

  it("salvage intake auto-returns a Parts-needed device to Awaiting repair (fulfillment unblocks, ticket 11)", async () => {
    const sku = await createSku(tech.agent, { name: "iPhone 16 Screen", price: "20.00" });
    const { deviceId } = await seedDemand(sku.id);
    // Park the device the way the attach path's auto-move leaves it.
    harness.db
      .prepare("UPDATE devices SET repair_status = 'Parts needed' WHERE id = ?")
      .run(deviceId);

    const response = await intake(tech.agent, sku.id, {
      source: "salvage",
      note: "screen survived a trade-in donor",
    });
    expect(response.status).toBe(201);
    const part = (response.body as IntakeResponse).parts[0] as ArrivalPart;
    expect(part.reserved).toBe(true);
    expect(part.reservationRefusal).toBeNull();

    const statusRow = harness.db
      .prepare("SELECT repair_status FROM devices WHERE id = ?")
      .get(deviceId) as { repair_status: string };
    expect(statusRow.repair_status).toBe("Awaiting repair");
    // The move is evented through setRepairStatus like any status change,
    // with the fulfillment as its reason.
    const move = (
      harness.db
        .prepare(
          `SELECT payload FROM events
            WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.status_changed'
            ORDER BY id`
        )
        .all(deviceId) as Array<{ payload: string }>
    )
      .map((row) => JSON.parse(row.payload))
      .find((payload: { to: string }) => payload.to === "Awaiting repair");
    expect(move).toMatchObject({
      from: "Parts needed",
      to: "Awaiting repair",
      reason: "need fulfilled",
    });
  });
});
