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
 * Ticket 29 — return orders (CONTEXT.md: Return Order, In-Transit): a
 * shipment of AVAILABLE parts back to a vendor. Scanning moves a part to the
 * shared In-Transit status; completing the order settles every part
 * Unavailable and BOOKS each part's effective price as revenue on the order
 * line — no manual value entry, unlike RMA credits and the buyback order's
 * hand-entered value, which are entered when the vendor/supplier pays.
 */

interface OrderPartBody {
  partId: number;
  serial: string;
  skuName: string;
  priceCents: number;
  price: string;
  booked: boolean;
  settledAt: string | null;
}

interface OrderBody {
  id: number;
  number: number;
  status: string;
  statusLabel: string;
  partCount: number;
  revenueCents: number;
  estimatedValueCents: number;
  parts: OrderPartBody[];
  events: Array<{ action: string; payload: Record<string, unknown> | null }>;
}

async function createSku(agent: Agent, price = "109.99") {
  const response = await agent
    .post("/api/skus")
    .send({ name: "iPhone 13 Screen", price, kind: "serialized" });
  expect(response.status).toBe(201);
  return response.body as { id: number };
}

async function intakeParts(agent: Agent, skuId: number, count: number): Promise<string[]> {
  const response = await agent.post(`/api/skus/${skuId}/parts`).send({
    source: "migration",
    quantity: count,
    counted: false,
  });
  expect(response.status).toBe(201);
  return (response.body.parts as Array<{ serial: string }>).map((part) => part.serial);
}

async function createReturn(agent: Agent, note = "Overstock back to Vendor A"): Promise<OrderBody> {
  const response = await agent.post("/api/return-orders").send({ note });
  expect(response.status).toBe(201);
  return response.body as OrderBody;
}

async function scanPart(agent: Agent, orderId: number, serial: string) {
  return agent.post(`/api/return-orders/${orderId}/parts`).send({ serial });
}

async function orderDetail(agent: Agent, orderId: number): Promise<OrderBody> {
  const response = await agent.get(`/api/return-orders/${orderId}`);
  expect(response.status).toBe(200);
  return response.body as OrderBody;
}

function partStatus(harness: TestHarness, serial: string): string {
  const row = harness.db
    .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
    .get(serial) as { status: string };
  return row.status;
}

describe("return order creation", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => harness.close());

  it("a tech creates one with a required opening note; it starts In-Transit", async () => {
    const missing = await tech.agent.post("/api/return-orders").send({});
    expect(missing.status).toBe(400);

    const order = await createReturn(tech.agent, "Returned screens to vendor");
    expect(order.status).toBe("in_transit");
    expect(order.statusLabel).toBe("In-Transit");
    expect(order.number).toBe(1);
    expect(order.partCount).toBe(0);
    expect(order.revenueCents).toBe(0);
    expect(order.events.map((event) => event.action)).toEqual([
      "return.created",
      "note.added",
    ]);
    expect(order.events[1].payload).toEqual({ text: "Returned screens to vendor" });
  });

  it("numbers are sequential and independent of RMA/buyback numbers", async () => {
    await createReturn(tech.agent);
    const second = await createReturn(tech.agent);
    expect(second.number).toBe(2);
    const rma = await tech.agent.post("/api/rma-orders").send({ note: "rma run" });
    expect((rma.body as { number: number }).number).toBe(1);
  });
});

describe("scanning parts onto a return order", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;
  let skuId: number;
  let serials: string[];

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
    skuId = (await createSku(tech.agent)).id;
    serials = await intakeParts(tech.agent, skuId, 3);
  });

  afterEach(() => harness.close());

  it("takes an AVAILABLE part and moves it to In-Transit, with events on both timelines", async () => {
    const [serial] = serials;
    const order = await createReturn(tech.agent);
    const response = await scanPart(tech.agent, order.id, serial);
    expect(response.status).toBe(201);

    const body = response.body as OrderBody;
    expect(body.partCount).toBe(1);
    expect(body.parts[0]).toMatchObject({
      serial,
      skuName: "iPhone 13 Screen",
      priceCents: 10999,
      booked: false,
      settledAt: null,
    });
    // The open order already shows its value at 100% (the committed revenue).
    expect(body.estimatedValueCents).toBe(10999);

    expect(partStatus(harness, serial)).toBe("in_transit");

    expect(body.events.map((event) => event.action)).toEqual([
      "return.created",
      "note.added",
      "return.part_added",
    ]);
    const partDetail = await tech.agent.get(`/api/parts/${serial}`);
    const actions = (partDetail.body.events as Array<{ action: string }>).map(
      (event) => event.action,
    );
    expect(actions).toEqual([
      "part.added",
      "part.status_changed",
      "part.added_to_return",
    ]);
    expect(partDetail.body.events[1].payload).toMatchObject({
      from: "available",
      to: "in_transit",
      returnOrderId: order.id,
      returnNumber: 1,
    });
  });

  it("normalizes the serial (whitespace, case)", async () => {
    const [serial] = serials;
    const order = await createReturn(tech.agent);
    const response = await scanPart(tech.agent, order.id, `  ${serial.toLowerCase()} `);
    expect(response.status).toBe(201);
  });

  it("refuses a non-Available part (RMA-status is not stock)", async () => {
    const [serial] = serials;
    await tech.agent.post(`/api/parts/${serial}/status`).send({ status: "rma", note: "slated" });
    const order = await createReturn(tech.agent);
    const response = await scanPart(tech.agent, order.id, serial);
    expect(response.status).toBe(409);
    expect((response.body as { error: string }).error).toContain("only Available parts");
  });

  it("refuses a part already in transit on another open order — naming that order", async () => {
    const [serial] = serials;
    const first = await createReturn(tech.agent);
    await scanPart(tech.agent, first.id, serial);
    const second = await createReturn(tech.agent);
    const response = await scanPart(tech.agent, second.id, serial);
    expect(response.status).toBe(409);
    expect((response.body as { error: string }).error).toContain(
      "already on return order #1 — a part can be on only one open return order"
    );
  });

  it("refuses a part in transit on an RMA order (cross-kind) and a missing serial", async () => {
    const [serial] = serials;
    const rma = await tech.agent.post("/api/rma-orders").send({ note: "rma run" });
    await tech.agent.post(`/api/parts/${serial}/status`).send({ status: "rma", note: "slated" });
    const rmaScan = await tech.agent
      .post(`/api/rma-orders/${(rma.body as { id: number }).id}/parts`)
      .send({ serial });
    expect(rmaScan.status).toBe(201);

    const order = await createReturn(tech.agent);
    const response = await scanPart(tech.agent, order.id, serial);
    expect(response.status).toBe(409);
    expect((response.body as { error: string }).error).toContain("in transit on RMA order #1");

    const missing = await scanPart(tech.agent, order.id, "P99999");
    expect(missing.status).toBe(404);
  });
});

describe("completing a return order books revenue", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;
  let skuId: number;
  let serials: string[];

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
    skuId = (await createSku(tech.agent)).id;
    serials = await intakeParts(tech.agent, skuId, 3);
  });

  afterEach(() => harness.close());

  it("requires a note and at least one part", async () => {
    const [serial] = serials;
    const order = await createReturn(tech.agent);
    await scanPart(tech.agent, order.id, serial);

    const noNote = await tech.agent.post(`/api/return-orders/${order.id}/complete`).send({});
    expect(noNote.status).toBe(400);

    const empty = await createReturn(tech.agent);
    const noParts = await tech.agent
      .post(`/api/return-orders/${empty.id}/complete`)
      .send({ note: "done" });
    expect(noParts.status).toBe(400);
  });

  it("settles every part Unavailable at its effective price (override honored), snapshotted on the line", async () => {
    const [plain, overridden, third] = serials;
    // Give one part its own price (ticket 23) — the revenue books THAT, not
    // the SKU catalog price.
    const price = await tech.agent
      .post(`/api/parts/${overridden}/price`)
      .send({ price: "89.50", note: "eBay-sourced unit" });
    expect(price.status).toBe(200);

    const order = await createReturn(tech.agent);
    await scanPart(tech.agent, order.id, plain);
    await scanPart(tech.agent, order.id, overridden);
    await scanPart(tech.agent, order.id, third);

    const response = await tech.agent
      .post(`/api/return-orders/${order.id}/complete`)
      .send({ note: "Vendor A accepted the return shipment" });
    expect(response.status).toBe(200);

    const body = response.body as OrderBody;
    expect(body.status).toBe("complete");
    expect(body.revenueCents).toBe(10999 + 8950 + 10999);
    expect(body.parts.every((part) => part.booked)).toBe(true);
    for (const serial of serials) {
      expect(partStatus(harness, serial)).toBe("unavailable");
    }
    const overriddenLine = body.parts.find((part) => part.serial === overridden)!;
    expect(overriddenLine.priceCents).toBe(8950);

    // The completion writes one settlement event per part plus the note and
    // the transition.
    expect(body.events.map((event) => event.action)).toEqual([
      "return.created",
      "note.added",
      "return.part_added",
      "return.part_added",
      "return.part_added",
      "return.part_settled",
      "return.part_settled",
      "return.part_settled",
      "note.added",
      "return.status_changed",
    ]);
  });

  it("snapshots at completion — a reprice afterwards does not rewrite booked revenue", async () => {
    const [serial] = serials;
    const order = await createReturn(tech.agent);
    await scanPart(tech.agent, order.id, serial);
    await tech.agent.post(`/api/return-orders/${order.id}/complete`).send({ note: "shipped" });

    // Reprice the SKU after the return completed.
    const repriced = await tech.agent.patch(`/api/skus/${skuId}`).send({ price: "50.00", note: "market dropped" });
    expect(repriced.status).toBe(200);

    const detail = await orderDetail(tech.agent, order.id);
    expect(detail.revenueCents).toBe(10999);
  });

  it("refuses to re-complete", async () => {
    const [serial] = serials;
    const order = await createReturn(tech.agent);
    await scanPart(tech.agent, order.id, serial);
    await tech.agent.post(`/api/return-orders/${order.id}/complete`).send({ note: "one" });
    const again = await tech.agent
      .post(`/api/return-orders/${order.id}/complete`)
      .send({ note: "two" });
    expect(again.status).toBe(409);
  });

  it("a completed order takes no more parts", async () => {
    const [serial, second] = serials;
    const order = await createReturn(tech.agent);
    await scanPart(tech.agent, order.id, serial);
    await tech.agent.post(`/api/return-orders/${order.id}/complete`).send({ note: "done" });
    const late = await scanPart(tech.agent, order.id, second);
    expect(late.status).toBe(409);
  });
});

describe("the bare parts endpoint vs a part on an open return order", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => harness.close());

  it("refuses to change an in-transit part's status outside its order", async () => {
    const skuId = (await createSku(tech.agent)).id;
    const [serial] = await intakeParts(tech.agent, skuId, 1);
    const order = await createReturn(tech.agent);
    await scanPart(tech.agent, order.id, serial);

    const flip = await tech.agent
      .post(`/api/parts/${serial}/status`)
      .send({ status: "available", note: "changed my mind" });
    expect(flip.status).toBe(409);
    expect((flip.body as { error: string }).error).toContain(
      "attached to in-transit return order #1"
    );
  });

  it("cannot set In-Transit through the bare endpoint at all", async () => {
    const skuId = (await createSku(tech.agent)).id;
    const [serial] = await intakeParts(tech.agent, skuId, 1);
    const response = await tech.agent
      .post(`/api/parts/${serial}/status`)
      .send({ status: "in_transit", note: "trying" });
    expect(response.status).toBe(400);
  });
});

describe("GET /api/return-orders and notes/timeline", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;
  let skuId: number;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
    skuId = (await createSku(tech.agent)).id;
  });

  afterEach(() => harness.close());

  it("lists orders newest-first with their running value", async () => {
    const [first, second] = await intakeParts(tech.agent, skuId, 3);
    const order1 = await createReturn(tech.agent, "first");
    await scanPart(tech.agent, order1.id, first);
    const order2 = await createReturn(tech.agent, "second");
    await scanPart(tech.agent, order2.id, second);
    await tech.agent
      .post(`/api/return-orders/${order2.id}/complete`)
      .send({ note: "shipped" });

    const response = await tech.agent.get("/api/return-orders");
    const list = response.body as OrderBody[];
    expect(list.map((order) => order.number)).toEqual([2, 1]);
    expect(list[0].revenueCents).toBe(10999);
    expect(list[1].revenueCents).toBe(0); // open: nothing booked yet
    expect(list[1].estimatedValueCents).toBe(10999);
  });

  it("adds notes onto the immutable order timeline", async () => {
    const order = await createReturn(tech.agent, "opening");
    const note = await tech.agent.post(`/api/return-orders/${order.id}/notes`).send({
      note: "vendor confirmed the RMA window",
    });
    expect(note.status).toBe(201);
    const detail = await orderDetail(tech.agent, order.id);
    expect(detail.events.map((event) => event.action)).toEqual([
      "return.created",
      "note.added",
      "note.added",
    ]);
  });

  it("404s a missing order and refuses a bad id", async () => {
    const missing = await tech.agent.get("/api/return-orders/9999");
    expect(missing.status).toBe(404);
    const bad = await tech.agent.get("/api/return-orders/abc");
    expect(bad.status).toBe(400);
  });
});

describe("returns-revenue report (ticket 12 seam, ticket 29)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => harness.close());

  it("manager downloads completed return revenue by completion date", async () => {
    const manager = await harness.loginAs(MANAGER);
    const skuId = (await createSku(tech.agent, "109.99")).id;
    const [a, b] = await intakeParts(tech.agent, skuId, 2);

    // An open order (scanned but not completed) books no revenue yet.
    const open = await createReturn(tech.agent);
    await scanPart(tech.agent, open.id, a);

    const order = await createReturn(tech.agent);
    await scanPart(tech.agent, order.id, b);
    await tech.agent.post(`/api/return-orders/${order.id}/complete`).send({ note: "shipped" });

    const response = await manager.agent.get(
      "/api/reports/returns-revenue?from=2026-01-01&to=2026-12-31"
    );
    expect(response.status).toBe(200);
    expect(response.text).toContain("Returns revenue");
    expect(response.text).toContain(b);
    expect(response.text).not.toContain(a);
    expect(response.text).toContain("109.99");
  });

  it("is manager-only", async () => {
    const response = await tech.agent.get(
      "/api/reports/returns-revenue?from=2026-01-01&to=2026-12-31"
    );
    expect(response.status).toBe(403);
  });
});
