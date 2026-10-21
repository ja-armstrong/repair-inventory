import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;
const DAY_MS = 24 * 60 * 60 * 1000;

interface TimelineEntry {
  id: number;
  at: string;
  action: string;
  actor: { id: number; email: string } | null;
  payload: Record<string, unknown> | null;
}

interface RmaOrderPartBody {
  partId: number;
  serial: string;
  skuId: number;
  skuName: string;
  addedAt: string;
  addedByEmail: string;
  disposition: "credited" | "rejected" | null;
  dispositionLabel: string | null;
  creditCents: number | null;
  credit: string | null;
  dispositionNote: string | null;
  settledAt: string | null;
}

interface RmaOrderBody {
  id: number;
  number: number;
  status: "in_transit" | "complete";
  statusLabel: string;
  createdAt: string;
  createdByEmail: string;
  completedAt: string | null;
  partCount: number;
  creditCents: number;
  parts: RmaOrderPartBody[];
  events: TimelineEntry[];
}

interface RmaPartPoolBody {
  id: number;
  serial: string;
  skuId: number;
  skuName: string;
  rmaOrderId: number | null;
  rmaNumber: number | null;
}

interface CreditReportBody {
  from: string | null;
  to: string | null;
  totalCreditCents: number;
  creditedParts: number;
  rejectedParts: number;
  orders: Array<{
    id: number;
    number: number;
    completedAt: string;
    partCount: number;
    creditCents: number;
  }>;
}

/** Creates a serialized SKU and returns its id. */
async function createSku(agent: LoggedInAgent["agent"]): Promise<number> {
  const response = await agent
    .post("/api/skus")
    .send({ name: "iPhone 13 Screen", price: "109.99", kind: "serialized" });
  expect(response.status).toBe(201);
  return response.body.id as number;
}

/** Intakes serialized parts and returns their serials (P00001-style). */
async function intakeParts(
  agent: LoggedInAgent["agent"],
  skuId: number,
  quantity: number,
): Promise<string[]> {
  const response = await agent.post(`/api/skus/${skuId}/parts`).send({ source: "migration", quantity, counted: false });
  expect(response.status).toBe(201);
  return (response.body.parts as Array<{ serial: string }>).map((part) => part.serial);
}

/** Moves a part to RMA status through the parts domain's status endpoint. */
async function markRma(
  agent: LoggedInAgent["agent"],
  serial: string,
  note = "slated for return to the vendor",
): Promise<void> {
  const response = await agent
    .post(`/api/parts/${serial}/status`)
    .send({ status: "rma", note });
  expect(response.status).toBe(200);
}

/** Creates an RMA order with the required opening note. */
async function createRma(
  agent: LoggedInAgent["agent"],
  note = "Returning defective screens to Vendor A",
): Promise<RmaOrderBody> {
  const response = await agent.post("/api/rma-orders").send({ note });
  expect(response.status).toBe(201);
  return response.body as RmaOrderBody;
}

/** Scans (types) a serial onto an RMA order. */
function scanPart(
  agent: LoggedInAgent["agent"],
  orderId: number,
  serial: string,
): ReturnType<LoggedInAgent["agent"]["post"]> {
  return agent.post(`/api/rma-orders/${orderId}/parts`).send({ serial });
}

/** Builds one open RMA order carrying the given RMA-status serials. */
async function buildOrder(
  agent: LoggedInAgent["agent"],
  serials: string[],
): Promise<RmaOrderBody> {
  const order = await createRma(agent);
  for (const serial of serials) {
    const response = await scanPart(agent, order.id, serial);
    expect(response.status).toBe(201);
  }
  return order;
}

describe("POST /api/rma-orders", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness();
  });
  afterEach(() => {
    harness.close();
  });

  it("creates an In-Transit order with sequential numbers and a required opening note", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const first = await createRma(tech.agent);
    const second = await createRma(tech.agent);

    expect(first).toMatchObject({
      number: 1,
      status: "in_transit",
      statusLabel: "In-Transit",
      completedAt: null,
      partCount: 0,
      creditCents: 0,
      createdByEmail: "tech@acme.co",
    });
    expect(second.number).toBe(2);
    expect(first.createdAt).toBe(harness.clock.now().toISOString());

    // The opening note is the timeline's first note, after the creation event.
    expect(first.events.map((event) => event.action)).toEqual(["rma.created", "note.added"]);
    expect(first.events[1].payload).toEqual({ text: "Returning defective screens to Vendor A" });
    expect(first.events[1].actor?.email).toBe("tech@acme.co");

    const row = harness.db
      .prepare("SELECT number, status, created_by FROM rma_orders WHERE id = ?")
      .get(first.id) as { number: number; status: string; created_by: number };
    expect(row).toEqual({ number: 1, status: "in_transit", created_by: tech.user.id });
  });

  it("rejects creation without a note", async () => {
    const manager = await harness.loginAs(MANAGER);
    const response = await manager.agent.post("/api/rma-orders").send({ note: "   " });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("opening note");
    const count = harness.db.prepare("SELECT COUNT(*) AS n FROM rma_orders").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("lists orders newest first with part counts and credit totals", async () => {
    const manager = await harness.loginAs(MANAGER);
    const skuId = await createSku(manager.agent);
    const [serial] = await intakeParts(manager.agent, skuId, 1);
    await markRma(manager.agent, serial);
    const order = await buildOrder(manager.agent, [serial]);
    await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "vendor settled",
      parts: [{ serial, disposition: "credited", credit: "45.50", note: "credit issued" }],
    });

    await createRma(manager.agent);
    const list = await manager.agent.get("/api/rma-orders");
    expect(list.status).toBe(200);
    expect(list.body.map((entry: { number: number }) => entry.number)).toEqual([2, 1]);
    expect(list.body[1]).toMatchObject({
      status: "complete",
      partCount: 1,
      creditCents: 4550,
    });
    expect(list.body[0]).toMatchObject({ status: "in_transit", partCount: 0, creditCents: 0 });
  });
});

describe("GET /api/rma-parts", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness();
  });
  afterEach(() => {
    harness.close();
  });

  it("lists all RMA-status parts, flagging the open order they are attached to", async () => {
    const manager = await harness.loginAs(MANAGER);
    const skuId = await createSku(manager.agent);
    const [rmaSerial, attachedSerial, availableSerial] = await intakeParts(manager.agent, skuId, 3);
    await markRma(manager.agent, rmaSerial);
    await markRma(manager.agent, attachedSerial);
    const order = await buildOrder(manager.agent, [attachedSerial]);

    const response = await manager.agent.get("/api/rma-parts");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      {
        id: expect.any(Number),
        serial: rmaSerial,
        skuId,
        skuName: "iPhone 13 Screen",
        rmaOrderId: null,
        rmaNumber: null,
      },
      {
        id: expect.any(Number),
        serial: attachedSerial,
        skuId,
        skuName: "iPhone 13 Screen",
        rmaOrderId: order.id,
        rmaNumber: order.number,
      },
    ]);
    // The Available part is not in the pool.
    expect(JSON.stringify(response.body)).not.toContain(availableSerial);
  });
});

describe("POST /api/rma-orders/:id/parts (scan to add)", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;
  let skuId: number;
  let serials: string[];

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    skuId = await createSku(manager.agent);
    serials = await intakeParts(manager.agent, skuId, 4);
  });
  afterEach(() => {
    harness.close();
  });

  it("adds an RMA-status part; it becomes In-Transit, attached, with events on both timelines", async () => {
    const [serial] = serials;
    await markRma(manager.agent, serial);
    const order = await createRma(manager.agent);
    const response = await scanPart(manager.agent, order.id, serial);

    expect(response.status).toBe(201);
    expect(response.body.partCount).toBe(1);
    expect(response.body.parts[0]).toMatchObject({
      serial,
      skuId,
      skuName: "iPhone 13 Screen",
      addedByEmail: MANAGER,
      disposition: null,
      creditCents: null,
      settledAt: null,
    });

    // Ticket 29: the scan moves the part to In-Transit — attached to the
    // order and physically gone with it.
    const partRow = harness.db
      .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
      .get(serial) as { status: string };
    expect(partRow.status).toBe("in_transit");

    const link = harness.db
      .prepare("SELECT rma_order_id, part_id FROM rma_order_parts WHERE part_id = ?")
      .get(response.body.parts[0].partId) as { rma_order_id: number; part_id: number };
    expect(link.rma_order_id).toBe(order.id);

    // Event on the order timeline...
    expect((response.body.events as TimelineEntry[]).map((event) => event.action)).toEqual([
      "rma.created",
      "note.added",
      "rma.part_added",
    ]);
    expect(response.body.events[2].payload).toEqual({ serial });
    // ...and on the part's own timeline: intake, the RMA marking, the scan's
    // In-Transit transition, and the attachment note (ticket 29).
    const partDetail = await manager.agent.get(`/api/parts/${serial}`);
    expect(partDetail.status).toBe(200);
    const actions = (partDetail.body.events as TimelineEntry[]).map((event) => event.action);
    expect(actions).toEqual([
      "part.added",
      "part.status_changed",
      "part.status_changed",
      "part.added_to_rma",
    ]);
    const scanEvent = partDetail.body.events[2];
    expect(scanEvent.payload).toMatchObject({ from: "rma", to: "in_transit" });
    const attachEvent = partDetail.body.events[3];
    expect(attachEvent.payload).toEqual({ rmaOrderId: order.id, rmaNumber: order.number });
  });

  it("normalizes the serial like the parts domain (whitespace, case)", async () => {
    const [serial] = serials;
    await markRma(manager.agent, serial);
    const order = await createRma(manager.agent);
    const response = await scanPart(manager.agent, order.id, `  ${serial.toLowerCase()} `);
    expect(response.status).toBe(201);
    expect(response.body.partCount).toBe(1);
  });

  it("rejects an unknown serial with 404", async () => {
    const order = await createRma(manager.agent);
    const response = await scanPart(manager.agent, order.id, "P99999");
    expect(response.status).toBe(404);
    expect(response.body.error).toContain("P99999");
  });

  it("rejects a part that is not RMA-status, without touching it", async () => {
    const [availableSerial] = serials;
    const order = await createRma(manager.agent);
    const response = await scanPart(manager.agent, order.id, availableSerial);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain(availableSerial);
    expect(response.body.error).toContain("Available");
    expect(response.body.error).toContain("RMA");
    const count = harness.db
      .prepare("SELECT COUNT(*) AS n FROM rma_order_parts")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects a part already on this order", async () => {
    const [serial] = serials;
    await markRma(manager.agent, serial);
    const order = await buildOrder(manager.agent, [serial]);
    const response = await scanPart(manager.agent, order.id, serial);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("already");
    const count = harness.db
      .prepare("SELECT COUNT(*) AS n FROM rma_order_parts WHERE rma_order_id = ?")
      .get(order.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it("rejects a part already on another open RMA order", async () => {
    const [serial] = serials;
    await markRma(manager.agent, serial);
    const first = await buildOrder(manager.agent, [serial]);
    const second = await createRma(manager.agent);
    const response = await scanPart(manager.agent, second.id, serial);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("already");
    expect(response.body.error).toContain(`#${first.number}`);
    const count = harness.db
      .prepare("SELECT COUNT(*) AS n FROM rma_order_parts WHERE rma_order_id = ?")
      .get(second.id) as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects adding parts to a completed order", async () => {
    const [serial, otherSerial] = serials;
    await markRma(manager.agent, serial);
    await markRma(manager.agent, otherSerial);
    const order = await buildOrder(manager.agent, [serial]);
    const completed = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "all settled",
      parts: [{ serial, disposition: "rejected", note: "vendor refused it" }],
    });
    expect(completed.status).toBe(200);

    const response = await scanPart(manager.agent, order.id, otherSerial);
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("complete");
  });

  it("rejects a missing serial and an unknown order", async () => {
    const order = await createRma(manager.agent);
    const missing = await manager.agent.post(`/api/rma-orders/${order.id}/parts`).send({});
    expect(missing.status).toBe(400);

    const unknown = await scanPart(manager.agent, 999, "P00001");
    expect(unknown.status).toBe(404);
  });
});

describe("POST /api/rma-orders/:id/notes", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness();
  });
  afterEach(() => {
    harness.close();
  });

  it("adds a note to the merged timeline; empty text is rejected", async () => {
    const manager = await harness.loginAs(MANAGER);
    const order = await createRma(manager.agent);

    const added = await manager.agent
      .post(`/api/rma-orders/${order.id}/notes`)
      .send({ note: "vendor wants these boxed separately" });
    expect(added.status).toBe(201);
    expect(added.body.action).toBe("note.added");
    expect(added.body.payload).toEqual({ text: "vendor wants these boxed separately" });

    const empty = await manager.agent
      .post(`/api/rma-orders/${order.id}/notes`)
      .send({ note: "" });
    expect(empty.status).toBe(400);

    const detail = await manager.agent.get(`/api/rma-orders/${order.id}`);
    expect(detail.body.events.map((event: TimelineEntry) => event.action)).toEqual([
      "rma.created",
      "note.added",
      "note.added",
    ]);
  });
});

describe("POST /api/rma-orders/:id/complete", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;
  let skuId: number;
  let serials: string[];

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    skuId = await createSku(manager.agent);
    serials = await intakeParts(manager.agent, skuId, 3);
  });
  afterEach(() => {
    harness.close();
  });

  it("settles every part as Unavailable with per-part disposition, credit, and notes; any user may complete", async () => {
    const [creditedSerial, rejectedSerial] = serials;
    await markRma(manager.agent, creditedSerial);
    await markRma(manager.agent, rejectedSerial);
    const order = await buildOrder(manager.agent, [creditedSerial, rejectedSerial]);

    // A tech — not the manager — completes the order.
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const response = await tech.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "Vendor A settled: one credit, one rejection",
      parts: [
        { serial: creditedSerial, disposition: "credited", credit: "45.50", note: "credit issued" },
        { serial: rejectedSerial, disposition: "rejected", note: "screen cracked in shipping" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "complete",
      statusLabel: "Complete",
      completedAt: harness.clock.now().toISOString(),
      partCount: 2,
      creditCents: 4550,
      createdByEmail: MANAGER,
    });

    // EVERY part on the order became Unavailable.
    const statuses = harness.db
      .prepare("SELECT serial, status FROM serialized_parts WHERE serial IN (?, ?) ORDER BY id")
      .all(creditedSerial, rejectedSerial) as Array<{ serial: string; status: string }>;
    expect(statuses.map((row) => row.status)).toEqual(["unavailable", "unavailable"]);

    // Per-part disposition captured with credit and notes.
    const settlements = harness.db
      .prepare(
        `SELECT p.serial AS serial, rp.disposition, rp.credit_cents, rp.disposition_note, rp.settled_at
           FROM rma_order_parts rp JOIN serialized_parts p ON p.id = rp.part_id
          WHERE rp.rma_order_id = ? ORDER BY p.id`
      )
      .all(order.id) as Array<{
      serial: string;
      disposition: string;
      credit_cents: number | null;
      disposition_note: string;
      settled_at: string;
    }>;
    expect(settlements).toEqual([
      {
        serial: creditedSerial,
        disposition: "credited",
        credit_cents: 4550,
        disposition_note: "credit issued",
        settled_at: harness.clock.now().toISOString(),
      },
      {
        serial: rejectedSerial,
        disposition: "rejected",
        credit_cents: null,
        disposition_note: "screen cracked in shipping",
        settled_at: harness.clock.now().toISOString(),
      },
    ]);

    // The order detail exposes the same data at the seam.
    const credited = response.body.parts.find(
      (part: RmaOrderPartBody) => part.serial === creditedSerial,
    );
    expect(credited).toMatchObject({
      disposition: "credited",
      dispositionLabel: "Credited",
      creditCents: 4550,
      credit: "45.50",
      dispositionNote: "credit issued",
    });
    const rejected = response.body.parts.find(
      (part: RmaOrderPartBody) => part.serial === rejectedSerial,
    );
    expect(rejected).toMatchObject({
      disposition: "rejected",
      dispositionLabel: "RMA-rejected",
      creditCents: null,
      credit: null,
      dispositionNote: "screen cracked in shipping",
    });

    // Events on the order timeline: settlements, the completion note, the transition.
    expect(response.body.events.map((event: TimelineEntry) => event.action)).toEqual([
      "rma.created",
      "note.added",
      "rma.part_added",
      "rma.part_added",
      "rma.part_settled",
      "rma.part_settled",
      "note.added",
      "rma.status_changed",
    ]);
    expect(response.body.events[4].payload).toEqual({
      serial: creditedSerial,
      disposition: "credited",
      creditCents: 4550,
      note: "credit issued",
    });
    expect(response.body.events[6].payload).toEqual({ text: "Vendor A settled: one credit, one rejection" });
    expect(response.body.events[7].payload).toEqual({ from: "in_transit", to: "complete" });

    // ...and events on each part's own timeline.
    for (const serial of [creditedSerial, rejectedSerial]) {
      const partDetail = await manager.agent.get(`/api/parts/${serial}`);
      const settledEvent = (partDetail.body.events as TimelineEntry[]).find(
        (event) => event.action === "part.status_changed" && event.payload?.to === "unavailable",
      );
      expect(settledEvent).toBeDefined();
      expect(settledEvent!.payload).toMatchObject({
        from: "in_transit",
        to: "unavailable",
        rmaOrderId: order.id,
        rmaNumber: order.number,
      });
    }
  });

  it("requires a completion note", async () => {
    const [serial] = serials;
    await markRma(manager.agent, serial);
    const order = await buildOrder(manager.agent, [serial]);

    const response = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      parts: [{ serial, disposition: "rejected", note: "refused" }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("note");
  });

  it("requires a disposition for every part on the order, naming the missing serials", async () => {
    const [first, second] = serials;
    await markRma(manager.agent, first);
    await markRma(manager.agent, second);
    const order = await buildOrder(manager.agent, [first, second]);

    const response = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "settling",
      parts: [{ serial: first, disposition: "rejected", note: "refused" }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain(second);
    expect(response.body.error).toContain("disposition");

    // Nothing settled — the parts stay In-Transit on the still-open order.
    const statuses = harness.db
      .prepare("SELECT status FROM serialized_parts WHERE serial IN (?, ?)")
      .all(first, second) as Array<{ status: string }>;
    expect(statuses.every((row) => row.status === "in_transit")).toBe(true);
    const row = harness.db
      .prepare("SELECT status FROM rma_orders WHERE id = ?")
      .get(order.id) as { status: string };
    expect(row.status).toBe("in_transit");
  });

  it("rejects entries for serials not on the order and duplicate entries", async () => {
    const [onOrder, offOrder] = serials;
    await markRma(manager.agent, onOrder);
    await markRma(manager.agent, offOrder);
    const order = await buildOrder(manager.agent, [onOrder]);

    const off = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "settling",
      parts: [
        { serial: onOrder, disposition: "rejected", note: "refused" },
        { serial: offOrder, disposition: "rejected", note: "not mine" },
      ],
    });
    expect(off.status).toBe(400);
    expect(off.body.error).toContain(offOrder);

    const duplicate = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "settling",
      parts: [
        { serial: onOrder, disposition: "rejected", note: "refused" },
        { serial: onOrder, disposition: "credited", credit: "1.00", note: "again" },
      ],
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error).toContain("once");
  });

  it("requires a money credit value for a credited part and refuses credits on rejected parts", async () => {
    const [serial] = serials;
    await markRma(manager.agent, serial);
    const order = await buildOrder(manager.agent, [serial]);

    const noCredit = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "settling",
      parts: [{ serial, disposition: "credited", note: "no value" }],
    });
    expect(noCredit.status).toBe(400);
    expect(noCredit.body.error).toContain("credit");

    const badCredit = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "settling",
      parts: [{ serial, disposition: "credited", credit: "12.345", note: "bad money" }],
    });
    expect(badCredit.status).toBe(400);

    const rejectedWithCredit = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "settling",
      parts: [{ serial, disposition: "rejected", credit: "5.00", note: "refused" }],
    });
    expect(rejectedWithCredit.status).toBe(400);
  });

  it("requires a per-part note for every disposition", async () => {
    const [serial] = serials;
    await markRma(manager.agent, serial);
    const order = await buildOrder(manager.agent, [serial]);

    const response = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "settling",
      parts: [{ serial, disposition: "rejected" }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("note");
  });

  it("refuses to complete an order with no parts", async () => {
    const order = await createRma(manager.agent);
    const response = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "nothing to send",
      parts: [],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("no parts");
  });

  it("rejects completing an already-complete order", async () => {
    const [serial] = serials;
    await markRma(manager.agent, serial);
    const order = await buildOrder(manager.agent, [serial]);
    const first = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "settled",
      parts: [{ serial, disposition: "credited", credit: "10.00", note: "credit" }],
    });
    expect(first.status).toBe(200);

    const second = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "again",
      parts: [{ serial, disposition: "credited", credit: "10.00", note: "credit" }],
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toContain("already complete");
  });

  it("returns 404 for an unknown order", async () => {
    const response = await manager.agent.post("/api/rma-orders/999/complete").send({
      note: "n/a",
      parts: [],
    });
    expect(response.status).toBe(404);
  });
});

describe("GET /api/rma-credits", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
  });
  afterEach(() => {
    harness.close();
  });

  async function settleOrder(serials: Array<{ serial: string; credit: string; note: string }>): Promise<void> {
    const order = await createRma(manager.agent);
    for (const { serial } of serials) {
      const response = await scanPart(manager.agent, order.id, serial);
      expect(response.status).toBe(201);
    }
    const response = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "vendor settled",
      parts: serials.map(({ serial, credit, note }) => ({
        serial,
        disposition: "credited",
        credit,
        note,
      })),
    });
    expect(response.status).toBe(200);
  }

  it("sums credits over an interval, breaking them down per order", async () => {
    const skuId = await createSku(manager.agent);
    const [earlyA, earlyB, late] = await intakeParts(manager.agent, skuId, 3);
    for (const serial of [earlyA, earlyB, late]) {
      await markRma(manager.agent, serial);
    }

    await settleOrder([
      { serial: earlyA, credit: "45.50", note: "credit" },
      { serial: earlyB, credit: "4.50", note: "credit" },
    ]);
    harness.clock.advance(30 * DAY_MS);
    await settleOrder([{ serial: late, credit: "100.00", note: "credit" }]);

    // The whole interval: both orders.
    const all = await manager.agent.get("/api/rma-credits");
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({
      from: null,
      to: null,
      totalCreditCents: 15000,
      creditedParts: 3,
      rejectedParts: 0,
    });
    expect(all.body.orders).toHaveLength(2);

    // A window that contains only the second completion.
    const from = new Date(harness.clock.now().getTime() - 10 * DAY_MS).toISOString();
    const to = harness.clock.now().toISOString();
    const windowed = await manager.agent.get(`/api/rma-credits?from=${from}&to=${to}`);
    expect(windowed.status).toBe(200);
    expect(windowed.body).toMatchObject({
      from,
      to,
      totalCreditCents: 10000,
      creditedParts: 1,
      rejectedParts: 0,
    });
    expect(windowed.body.orders.map((order: { number: number }) => order.number)).toEqual([2]);

    // A window before everything: nothing.
    const before = await manager.agent.get(
      `/api/rma-credits?from=2020-01-01T00:00:00.000Z&to=2020-12-31T00:00:00.000Z`,
    );
    expect(before.status).toBe(200);
    expect(before.body.totalCreditCents).toBe(0);
    expect(before.body.orders).toEqual([]);
  });

  it("counts RMA-rejected parts alongside credits", async () => {
    const skuId = await createSku(manager.agent);
    const [credited, rejected] = await intakeParts(manager.agent, skuId, 2);
    await markRma(manager.agent, credited);
    await markRma(manager.agent, rejected);
    const order = await buildOrder(manager.agent, [credited, rejected]);
    const response = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "mixed settlement",
      parts: [
        { serial: credited, disposition: "credited", credit: "20.00", note: "credit" },
        { serial: rejected, disposition: "rejected", note: "refused" },
      ],
    });
    expect(response.status).toBe(200);

    const report = await manager.agent.get("/api/rma-credits");
    expect(report.body).toMatchObject({
      totalCreditCents: 2000,
      creditedParts: 1,
      rejectedParts: 1,
    });
  });

  it("is manager-only", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const response = await tech.agent.get("/api/rma-credits");
    expect(response.status).toBe(403);
  });
});

describe("GET /api/rma-orders/:id/timeline", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness();
  });
  afterEach(() => {
    harness.close();
  });

  it("returns the merged, ordered, immutable timeline", async () => {
    const manager = await harness.loginAs(MANAGER);
    const skuId = await createSku(manager.agent);
    const [serial] = await intakeParts(manager.agent, skuId, 1);
    await markRma(manager.agent, serial);
    const order = await buildOrder(manager.agent, [serial]);

    const response = await manager.agent.get(`/api/rma-orders/${order.id}/timeline`);
    expect(response.status).toBe(200);
    const events = response.body as TimelineEntry[];
    expect(events.map((event) => event.action)).toEqual([
      "rma.created",
      "note.added",
      "rma.part_added",
    ]);
    // Chronological by id, user-stamped.
    expect(events.map((event) => event.id)).toEqual([...events.map((event) => event.id)].sort((a, b) => a - b));
    expect(events.every((event) => event.actor?.email === MANAGER)).toBe(true);

    // Immutable: no edit or delete endpoint exists for timeline entries.
    const edit = await manager.agent
      .patch(`/api/rma-orders/${order.id}/timeline`)
      .send({ id: events[0].id, text: "rewritten" });
    expect(edit.status).toBe(404);
    const removed = await manager.agent.delete(`/api/rma-orders/${order.id}/timeline`);
    expect(removed.status).toBe(404);
  });
});

function partStatusOf(harness: TestHarness, serial: string): string {
  const row = harness.db
    .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
    .get(serial) as { status: string };
  return row?.status;
}

/**
 * Ticket 14, hole 1: the bare parts-status endpoint and RMA complete both
 * write a part's status. A part attached to an in-transit RMA order must not
 * be flippable through the bare endpoint — completing the order is what
 * settles its status (every part becomes Unavailable).
 */
describe("the bare parts endpoint vs an in-transit RMA order (ticket 14, hole 1)", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness();
  });
  afterEach(() => {
    harness.close();
  });

  it("refuses to flip a part attached to an in-transit RMA order; completing the order still settles it", async () => {
    const manager = await harness.loginAs(MANAGER);
    const skuId = await createSku(manager.agent);
    const [attached, loose] = await intakeParts(manager.agent, skuId, 2);
    await markRma(manager.agent, attached);
    await markRma(manager.agent, loose);
    const order = await createRma(manager.agent);
    const scanned = await scanPart(manager.agent, order.id, attached);
    expect(scanned.status).toBe(201);

    // The hole: this flip used to succeed, leaving the part Available on an
    // in-transit order whose complete would later force it Unavailable.
    const flip = await manager.agent
      .post(`/api/parts/${attached}/status`)
      .send({ status: "available", note: "found on the shelf" });
    expect(flip.status).toBe(409);
    expect(String(flip.body.error)).toContain("RMA order");
    // Ticket 29: the scan already moved the part to In-Transit.
    expect(partStatusOf(harness, attached)).toBe("in_transit");

    // A RMA part NOT attached to an order can still be moved (unchanged rule).
    const ok = await manager.agent
      .post(`/api/parts/${loose}/status`)
      .send({ status: "available", note: "vendor took it back early" });
    expect(ok.status).toBe(200);
    expect(partStatusOf(harness, loose)).toBe("available");

    // Completing the order still settles the attached part to Unavailable.
    const complete = await manager.agent.post(`/api/rma-orders/${order.id}/complete`).send({
      note: "Vendor A settled",
      parts: [
        { serial: attached, disposition: "credited", credit: "10.00", note: "credit issued" },
      ],
    });
    expect(complete.status).toBe(200);
    expect(partStatusOf(harness, attached)).toBe("unavailable");
  });
});

describe("open RMA orders carry an estimated recovery (ticket 29)", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;
  let skuId: number;
  let serials: string[];

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    skuId = await createSku(manager.agent);
    serials = await intakeParts(manager.agent, skuId, 2);
  });
  afterEach(() => harness.close());

  it("the summary exposes the parts-value sum and a 50% estimate on the open order", async () => {
    const [first, second] = serials;
    await markRma(manager.agent, first);
    await markRma(manager.agent, second);
    const order = await createRma(manager.agent);
    await scanPart(manager.agent, order.id, first);
    const response = await scanPart(manager.agent, order.id, second);

    // Two screens at 109.99 = 219.98 total; the estimate is half.
    expect(response.body.partsValueCents).toBe(21998);
    expect(response.body.estimatedValueCents).toBe(10999);
  });

  it("the estimate follows a part's own price override, not just the SKU", async () => {
    const [serial] = serials;
    await markRma(manager.agent, serial);
    await manager.agent.post(`/api/parts/${serial}/price`).send({ price: "50.00", note: "eBay unit" });
    const order = await createRma(manager.agent);
    const response = await scanPart(manager.agent, order.id, serial);
    expect(response.body.partsValueCents).toBe(5000);
    expect(response.body.estimatedValueCents).toBe(2500);
  });
});
