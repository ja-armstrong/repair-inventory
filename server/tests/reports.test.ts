import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

/**
 * Ticket 12 — the five CSV reports (total expenses, RMA recovery, batches
 * completed, shrink, per-tech stats), each over an inclusive date range.
 *
 * One seeded ledger spans the interval boundary: events sit before `from`
 * (excluded), exactly at `from` 00:00:00.000Z (included), inside, exactly at
 * `to`+1ms past the end (excluded), and after `to`. Every report's CSV is
 * asserted against its exact expected text, which also pins the RFC-4180
 * quoting (the battery SKU's name carries a comma and a quote on purpose).
 *
 * The harness is built once in beforeAll because the scenario IS the test
 * fixture — the whole ledger is the unit under test.
 */

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

const SCREEN = { name: "iPhone 13 Screen", price: "109.99", kind: "serialized" };
const BATTERY = { name: 'Battery, Pro "Max"', price: "45.00", kind: "serialized" };
const ADHESIVE = { name: "Adhesive strips", price: "1.50", kind: "consumable" };

const FROM = "2026-09-01";
const TO = "2026-09-30";

interface SkuJson {
  id: number;
  name: string;
}

function csv(...lines: string[]): string {
  return lines.join("\r\n") + "\r\n";
}

async function createSku(agent: Agent, spec: { name: string; price: string; kind: string }): Promise<SkuJson> {
  const response = await agent.post("/api/skus").send(spec);
  expect(response.status).toBe(201);
  return response.body as SkuJson;
}

async function intakeParts(agent: Agent, skuId: number, count: number): Promise<string[]> {
  const response = await agent
    .post(`/api/skus/${skuId}/parts`)
    .send({ source: "migration", quantity: count, counted: false });
  expect(response.status).toBe(201);
  return (response.body.parts as Array<{ serial: string }>).map((part) => part.serial);
}

async function createBatch(agent: Agent, note = "Batch opened for triage"): Promise<{ id: number; number: number }> {
  const response = await agent.post("/api/batches").send({ note });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function addDevice(
  agent: Agent,
  batchId: number,
  imei: string,
  repairTimeMinutes: number
): Promise<{ id: number }> {
  const response = await agent.post(`/api/batches/${batchId}/devices`).send({
    modelName: "iPhone 13",
    statedIssue: "Cracked screen",
    imei,
    repairTimeMinutes,
  });
  expect(response.status).toBe(201);
  return response.body as { id: number };
}

async function addPart(agent: Agent, batchId: number, deviceId: number, skuId: number): Promise<void> {
  const response = await agent.post(`/api/batches/${batchId}/devices/${deviceId}/parts`).send({ skuId });
  expect(response.status).toBe(201);
}

async function recordConsumable(
  agent: Agent,
  batchId: number,
  deviceId: number,
  skuId: number,
  quantity: number,
  note?: string
): Promise<void> {
  const response = await agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/consumables`)
    .send({ skuId, quantity, ...(note !== undefined ? { note } : {}) });
  expect(response.status).toBe(201);
}

async function setStatus(
  agent: Agent,
  batchId: number,
  deviceId: number,
  repairStatus: string,
  resolutionNotes?: string
): Promise<void> {
  const response = await agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/status`)
    .send({ repairStatus, ...(resolutionNotes !== undefined ? { resolutionNotes } : {}) });
  expect(response.status).toBe(200);
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

async function approveBatch(agent: Agent, batchId: number): Promise<void> {
  await decideAll(agent, batchId);
  expect((await agent.post(`/api/batches/${batchId}/approve`).send({ note: "Costs look right" })).status).toBe(200);
}

async function closeBatch(agent: Agent, batchId: number): Promise<void> {
  expect((await agent.post(`/api/batches/${batchId}/close`).send({})).status).toBe(200);
}

async function createPo(
  agent: Agent,
  body: { purpose: string; shippingCost: string; lines: Array<{ skuId: number; quantity: number; unitPrice: string }> }
): Promise<{ id: number; number: number }> {
  const response = await agent.post("/api/purchase-orders").send({ ...body, note: "Opening note" });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number; expectedSerials: Array<{ serial: string }> };
}

async function approvePo(manager: Agent, poId: number): Promise<ApprovedPo> {
  const response = await manager.post(`/api/purchase-orders/${poId}/approve`).send({ note: "Approved" });
  expect(response.status).toBe(200);
  return response.body as ApprovedPo;
}

interface ApprovedPo {
  id: number;
  number: number;
  lines: Array<{ id: number; sku: { id: number; name: string; kind: string } }>;
  expectedSerials: Array<{ serial: string }>;
}

async function receivePo(agent: Agent, poId: number, serial: string): Promise<string> {
  const response = await agent.post(`/api/purchase-orders/${poId}/receive`).send({ serial });
  expect(response.status).toBe(200);
  return (response.body as { serial: string }).serial;
}

async function markRma(agent: Agent, serial: string): Promise<void> {
  const response = await agent.post(`/api/parts/${serial}/status`).send({ status: "rma", note: "slated for return" });
  expect(response.status).toBe(200);
}

async function setPartStatus(agent: Agent, serial: string, status: string, note: string): Promise<void> {
  const response = await agent.post(`/api/parts/${serial}/status`).send({ status, note });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function completeRma(
  agent: Agent,
  orderId: number,
  parts: Array<{ serial: string; disposition: "credited" | "rejected"; credit?: string; note: string }>
): Promise<void> {
  const response = await agent
    .post(`/api/rma-orders/${orderId}/complete`)
    .send({ note: "vendor settled", parts });
  expect(response.status).toBe(200);
}

async function createRma(agent: Agent): Promise<{ id: number; number: number }> {
  const response = await agent.post("/api/rma-orders").send({ note: "Returning defective parts" });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function scanRma(agent: Agent, orderId: number, serial: string): Promise<void> {
  expect((await agent.post(`/api/rma-orders/${orderId}/parts`).send({ serial })).status).toBe(201);
}

async function openAudit(agent: Agent): Promise<{ id: number }> {
  const response = await agent.post("/api/audits").send({});
  expect(response.status).toBe(201);
  return response.body as { id: number };
}

interface Scenario {
  harness: TestHarness;
  manager: LoggedInAgent;
  tech1: LoggedInAgent;
  tech2: LoggedInAgent;
  screenSerial: string;
  /** Battery serials in intake order; roles documented at each use below. */
  batterySerials: string[];
  batterySkuId: number;
  adhesiveSkuId: number;
  /** PO #2's received unit — the interval's one "Received part" expense line. */
  po2BatterySerial: string;
}

let scenario: Scenario;

beforeAll(async () => {
  const harness = createTestHarness();
  const { clock } = harness;
  const manager = await harness.loginAs(MANAGER);
  const tech1 = await harness.createUserAs("tech@acme.co", "tech");
  const tech2 = await harness.createUserAs("tech2@acme.co", "tech");

  // --- catalog --------------------------------------------------------------
  clock.set("2026-08-10T09:00:00.000Z");
  const screenSku = await createSku(tech1.agent, SCREEN);
  const batterySku = await createSku(tech1.agent, BATTERY);
  const adhesiveSku = await createSku(tech1.agent, ADHESIVE);

  // --- PO #1 (created BEFORE the interval; its shipping must not count) -----
  clock.set("2026-08-10T10:00:00.000Z");
  const po1 = await createPo(tech1.agent, {
    purpose: "August screens",
    shippingCost: "5.00",
    lines: [{ skuId: screenSku.id, quantity: 2, unitPrice: "100.00" }],
  });
  clock.set("2026-08-10T10:30:00.000Z");
  const approvedPo1 = await approvePo(manager.agent, po1.id);
  // Receiving refreshes the SKU price to the PO unit cost (100.00); the part
  // enters inventory with intake source purchase-order.
  clock.set("2026-08-12T09:00:00.000Z");
  const screenSerial = await receivePo(tech1.agent, po1.id, approvedPo1.expectedSerials[0].serial);

  // --- 11 migration batteries, each with a booked role ----------------------
  // [0] consumed by batch #1 (before) · [1] consumed by batch #2 (in, non-purchased)
  // [2] RMA #2 credited (in) · [3] RMA #2 rejected (in) · [4] audit-failed (in)
  // [5] RMA #1 credited (before) · [6] RMA #3 credited (after)
  // [7] damaged 08-20 (before) · [8] damaged 09-18 (in)
  // [9] audit-scanned, then consumed by batch #6 (after; oldest-Available pick)
  // [10] audit-scanned, then damaged 10-05 (after)
  clock.set("2026-08-13T09:00:00.000Z");
  const batterySerials = await intakeParts(tech1.agent, batterySku.id, 11);

  // --- batch #1: everything BEFORE the interval ------------------------------
  clock.set("2026-08-14T09:00:00.000Z");
  const batch1 = await createBatch(tech1.agent);
  const d1 = await addDevice(tech1.agent, batch1.id, "111111111111111", 120);
  await addPart(tech1.agent, batch1.id, d1.id, batterySku.id); // batterySerials[0]
  clock.set("2026-08-14T10:00:00.000Z");
  await approveBatch(manager.agent, batch1.id);
  clock.set("2026-08-14T11:00:00.000Z");
  await setStatus(tech1.agent, batch1.id, d1.id, "In progress");
  clock.set("2026-08-14T11:30:00.000Z");
  await setStatus(tech1.agent, batch1.id, d1.id, "Repaired", "Done.");
  clock.set("2026-08-15T09:00:00.000Z");
  await closeBatch(tech1.agent, batch1.id);

  // --- early RMA (#1, completed BEFORE the interval) -------------------------
  clock.set("2026-08-18T09:00:00.000Z");
  await markRma(tech1.agent, batterySerials[5]);
  clock.set("2026-08-19T09:00:00.000Z");
  const rma1 = await createRma(tech1.agent);
  await scanRma(tech1.agent, rma1.id, batterySerials[5]);
  clock.set("2026-08-20T09:00:00.000Z");
  await completeRma(tech1.agent, rma1.id, [
    { serial: batterySerials[5], disposition: "credited", credit: "10.00", note: "early credit" },
  ]);

  // --- early damage (BEFORE the interval) ------------------------------------
  clock.set("2026-08-20T15:00:00.000Z");
  await setPartStatus(tech2.agent, batterySerials[7], "damaged_by_tech", "dropped it");

  // --- batch #2: closed IN the interval with a purchased + a migrated part ---
  clock.set("2026-08-28T09:00:00.000Z");
  const batch2 = await createBatch(tech1.agent);
  const deviceA = await addDevice(tech1.agent, batch2.id, "222222222222222", 60);
  const deviceB = await addDevice(tech1.agent, batch2.id, "333333333333333", 30);
  await addPart(tech1.agent, batch2.id, deviceA.id, screenSku.id); // purchased unit, snapshotted 100.00
  await addPart(tech1.agent, batch2.id, deviceB.id, batterySku.id); // migration unit
  clock.set("2026-08-29T09:00:00.000Z");
  await recordConsumable(tech1.agent, batch2.id, deviceA.id, adhesiveSku.id, 2); // before the interval
  clock.set("2026-08-30T09:00:00.000Z");
  await approveBatch(manager.agent, batch2.id);
  clock.set("2026-08-31T23:59:59.999Z");
  await recordConsumable(manager.agent, batch2.id, deviceA.id, adhesiveSku.id, 1, "pre-window"); // 1ms before `from`
  clock.set("2026-09-01T00:00:00.000Z");
  await recordConsumable(manager.agent, batch2.id, deviceA.id, adhesiveSku.id, 1, "first of month"); // exactly `from` — INCLUDED
  clock.set("2026-09-04T09:00:00.000Z");
  const po2 = await createPo(tech1.agent, {
    purpose: "September batteries",
    shippingCost: "9.99",
    lines: [{ skuId: batterySku.id, quantity: 1, unitPrice: "45.00" }],
  }); // PO #2 — shipping INCLUDED
  clock.set("2026-09-04T10:00:00.000Z");
  const approvedPo2 = await approvePo(manager.agent, po2.id);
  clock.set("2026-09-05T09:00:00.000Z");
  await setStatus(tech1.agent, batch2.id, deviceA.id, "In progress");
  clock.set("2026-09-05T10:00:00.000Z");
  await setStatus(tech1.agent, batch2.id, deviceA.id, "Repaired", "Screen replaced.");
  clock.set("2026-09-06T09:00:00.000Z");
  await setStatus(tech1.agent, batch2.id, deviceB.id, "In progress");
  clock.set("2026-09-06T10:00:00.000Z");
  // Ticket 03: an UNREPAIRABLE device no longer consumes its parts at close —
  // they return to stock (which would re-route batterySerials[1] into the
  // audit-due pool and break this scenario's consumption fixture). The
  // scenario wants a consumed migration battery, so deviceB finishes Repaired.
  await setStatus(tech1.agent, batch2.id, deviceB.id, "Repaired", "Board reflowed.");
  clock.set("2026-09-10T12:00:00.000Z");
  await closeBatch(tech1.agent, batch2.id); // consumes the screen (a purchase: its cost was already expensed at receipt) and batterySerials[1] (non-purchased listing)

  // --- batch #3: one repaired device, one retriaged device -------------------
  clock.set("2026-09-12T09:00:00.000Z");
  const batch3 = await createBatch(tech2.agent);
  const deviceC = await addDevice(tech2.agent, batch3.id, "444444444444444", 90);
  const deviceD = await addDevice(tech2.agent, batch3.id, "555555555555555", 15);
  clock.set("2026-09-12T10:00:00.000Z");
  await markRma(tech1.agent, batterySerials[2]);
  await markRma(tech1.agent, batterySerials[3]);
  clock.set("2026-09-12T11:00:00.000Z");
  const rma2 = await createRma(tech1.agent);
  await scanRma(tech1.agent, rma2.id, batterySerials[2]);
  await scanRma(tech1.agent, rma2.id, batterySerials[3]);
  clock.set("2026-09-13T09:00:00.000Z");
  await approveBatch(manager.agent, batch3.id);
  clock.set("2026-09-14T09:00:00.000Z");
  await setStatus(tech1.agent, batch3.id, deviceC.id, "In progress");
  clock.set("2026-09-14T10:00:00.000Z");
  await setStatus(tech1.agent, batch3.id, deviceC.id, "Repaired", "Fixed.");
  clock.set("2026-09-15T09:00:00.000Z");
  await completeRma(tech1.agent, rma2.id, [
    { serial: batterySerials[2], disposition: "credited", credit: "45.50", note: "vendor credit" },
    { serial: batterySerials[3], disposition: "rejected", note: "refused by vendor" },
  ]); // IN the interval
  clock.set("2026-09-15T10:00:00.000Z");
  await setStatus(tech2.agent, batch3.id, deviceD.id, "In progress");
  clock.set("2026-09-16T09:00:00.000Z");
  await setStatus(tech2.agent, batch3.id, deviceD.id, "Additional issues present", "Board damage found.");
  // the retriage created batch #4 (Awaiting approval, one device)
  clock.set("2026-09-18T09:00:00.000Z");
  await closeBatch(tech2.agent, batch3.id); // 1 repaired, 1 retriaged
  clock.set("2026-09-18T15:00:00.000Z");
  await setPartStatus(tech2.agent, batterySerials[8], "damaged_by_tech", "cracked it"); // IN the interval

  // --- audit #1: exactly one audit failure inside the interval ---------------
  clock.set("2026-09-22T09:00:00.000Z");
  const audit = await openAudit(manager.agent);
  // Due (first audit: everything Available): batterySerials[4], [6], [9], [10].
  // Scan three; batterySerials[4] fails at close with no grace.
  clock.set("2026-09-22T09:30:00.000Z");
  expect((await manager.agent.post(`/api/audits/${audit.id}/scan`).send({ serial: batterySerials[6] })).status).toBe(200);
  clock.set("2026-09-22T10:00:00.000Z");
  expect((await manager.agent.post(`/api/audits/${audit.id}/scan`).send({ serial: batterySerials[9] })).status).toBe(200);
  clock.set("2026-09-22T10:30:00.000Z");
  expect((await manager.agent.post(`/api/audits/${audit.id}/scan`).send({ serial: batterySerials[10] })).status).toBe(200);
  clock.set("2026-09-23T09:00:00.000Z");
  expect((await manager.agent.post(`/api/audits/${audit.id}/close`).send({})).status).toBe(200);

  // PO #2's battery arrives AFTER the audit close: a receipt in the interval
  // is an expense at its received date. (Receiving it earlier would put an
  // Available unit into the audit's due pool and change the shrink fixture —
  // an unscanned due part fails at close with no grace.)
  clock.set("2026-09-24T09:00:00.000Z");
  const po2BatterySerial = await receivePo(tech1.agent, po2.id, approvedPo2.expectedSerials[0].serial);

  // --- holding batch #5: carries the exact-`to` boundary consumable ----------
  clock.set("2026-09-29T09:00:00.000Z");
  const batch5 = await createBatch(tech2.agent);
  const deviceF = await addDevice(tech2.agent, batch5.id, "777777777777777", 0);
  clock.set("2026-09-30T23:00:00.000Z");
  const po3 = await createPo(tech1.agent, {
    purpose: "End of month order",
    shippingCost: "3.33",
    lines: [
      { skuId: batterySku.id, quantity: 1, unitPrice: "45.00" },
      { skuId: adhesiveSku.id, quantity: 4, unitPrice: "1.50" },
    ],
  }); // PO #3 — created before `to` ends: shipping INCLUDED
  clock.set("2026-09-30T23:30:00.000Z");
  const approvedPo3 = await approvePo(manager.agent, po3.id);
  clock.set("2026-09-30T23:45:00.000Z");
  const adhesiveLine = approvedPo3.lines.find((line) => line.sku.id === adhesiveSku.id)!;
  const receivedConsumable = await tech1.agent
    .post(`/api/purchase-orders/${po3.id}/receive-consumable`)
    .send({ lineId: adhesiveLine.id, quantity: 4 });
  expect(receivedConsumable.status).toBe(200); // the interval's "Received consumable" expense line
  clock.set("2026-10-01T00:00:00.000Z");
  await recordConsumable(tech2.agent, batch5.id, deviceF.id, adhesiveSku.id, 1); // exactly `to`+1ms of range — EXCLUDED
  clock.set("2026-10-01T00:05:00.000Z");
  await createPo(tech1.agent, {
    purpose: "October restock",
    shippingCost: "2.22",
    lines: [{ skuId: batterySku.id, quantity: 1, unitPrice: "45.00" }],
  }); // PO #4 — EXCLUDED

  // --- everything AFTER the interval -----------------------------------------
  clock.set("2026-10-04T09:00:00.000Z");
  await markRma(tech1.agent, batterySerials[6]);
  clock.set("2026-10-04T09:30:00.000Z");
  const rma3 = await createRma(tech1.agent);
  await scanRma(tech1.agent, rma3.id, batterySerials[6]);
  clock.set("2026-10-04T10:00:00.000Z");
  const batch6 = await createBatch(tech2.agent);
  const deviceE = await addDevice(tech2.agent, batch6.id, "666666666666666", 45);
  await addPart(tech2.agent, batch6.id, deviceE.id, batterySku.id); // picks batterySerials[9] (oldest Available)
  clock.set("2026-10-04T11:00:00.000Z");
  await approveBatch(manager.agent, batch6.id);
  clock.set("2026-10-05T08:00:00.000Z");
  await setStatus(tech2.agent, batch6.id, deviceE.id, "In progress");
  clock.set("2026-10-05T08:30:00.000Z");
  await setStatus(tech2.agent, batch6.id, deviceE.id, "Repaired", "Fixed.");
  clock.set("2026-10-05T09:00:00.000Z");
  // batch #6's addPart picked batterySerials[9] (oldest Available); [10] is still free.
  await setPartStatus(tech2.agent, batterySerials[10], "damaged_by_tech", "dropped it again");
  clock.set("2026-10-05T10:00:00.000Z");
  await completeRma(tech1.agent, rma3.id, [
    { serial: batterySerials[6], disposition: "credited", credit: "20.00", note: "late credit" },
  ]);
  clock.set("2026-10-05T11:00:00.000Z");
  await closeBatch(tech2.agent, batch6.id);
  clock.set("2026-10-05T12:00:00.000Z");
  await createPo(tech1.agent, {
    purpose: "Late October restock",
    shippingCost: "7.77",
    lines: [{ skuId: batterySku.id, quantity: 1, unitPrice: "45.00" }],
  }); // PO #5 — EXCLUDED

  scenario = { harness, manager, tech1, tech2, screenSerial, batterySerials, batterySkuId: batterySku.id, adhesiveSkuId: adhesiveSku.id, po2BatterySerial };
});

afterAll(() => {
  scenario?.harness.close();
});

function csvBody(path: string): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  return scenario.manager.agent.get(path).then((response) => ({
    status: response.status,
    text: response.text as string,
    headers: response.headers as Record<string, string>,
  }));
}

describe("GET /api/reports/expenses", () => {
  it("renders the exact CSV: received parts and consumables at receipt, PO shipping, non-purchased summary", async () => {
    const { status, text } = await csvBody(`/api/reports/expenses?from=${FROM}&to=${TO}`);
    expect(status).toBe(200);
    expect(text).toBe(
      csv(
        `Total expenses,${FROM},${TO}`,
        `Category,Date,Reference,Detail,Amount`,
        `PO shipping,2026-09-04T09:00:00.000Z,PO #2,September batteries,9.99`,
        `Received part,2026-09-24T09:00:00.000Z,PO #2,"${scenario.po2BatterySerial} — Battery, Pro ""Max""",45.00`,
        `PO shipping,2026-09-30T23:00:00.000Z,PO #3,End of month order,3.33`,
        `Received consumable,2026-09-30T23:45:00.000Z,PO #3,Adhesive strips x 4,6.00`,
        `Total,,,,64.32`,
        ``,
        `Non-purchased consumption (excluded from expenses)`,
        `Date,Reference,Serial,SKU,Intake source,Price`,
        `2026-09-10T12:00:00.000Z,Batch #2,${scenario.batterySerials[1]},"Battery, Pro ""Max""",migration,45.00`,
        `Total,,,,,45.00`,
      ),
    );
  });

  it("consumable usage is no longer an expense — recording and removing usage leaves the report unchanged", async () => {
    scenario.harness.clock.set("2026-09-15T10:00:00.000Z");
    const batch = await createBatch(scenario.manager.agent, "usage is not spend");
    const device = await addDevice(scenario.manager.agent, batch.id, "999999999999999", 30);
    await recordConsumable(scenario.manager.agent, batch.id, device.id, scenario.adhesiveSkuId, 2);

    const withUsage = await csvBody(`/api/reports/expenses?from=${FROM}&to=${TO}`);
    // Usage never appears (the PO receipt is the consumable expense); the
    // total is the scenario's pinned 64.32 with no usage addition.
    expect(withUsage.text).not.toContain("Adhesive strips x 2");
    expect(withUsage.text).toContain(`Total,,,,64.32`);

    const usageId = (
      scenario.harness.db
        .prepare("SELECT id FROM device_consumables WHERE quantity = 2 ORDER BY id DESC LIMIT 1")
        .get() as { id: number }
    ).id;
    const removed = await scenario.manager.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/consumables/${usageId}/remove`)
      .send({ note: "recorded twice by mistake" });
    expect(removed.status).toBe(200);

    const afterRemoval = await csvBody(`/api/reports/expenses?from=${FROM}&to=${TO}`);
    expect(afterRemoval.text).toBe(withUsage.text);
  });

  it("renders only headers and zero totals for an empty interval", async () => {
    const { status, text } = await csvBody("/api/reports/expenses?from=2020-01-01&to=2020-01-31");
    expect(status).toBe(200);
    expect(text).toBe(
      csv(
        `Total expenses,2020-01-01,2020-01-31`,
        `Category,Date,Reference,Detail,Amount`,
        `Total,,,,0.00`,
        ``,
        `Non-purchased consumption (excluded from expenses)`,
        `Date,Reference,Serial,SKU,Intake source,Price`,
        `Total,,,,,0.00`,
      ),
    );
  });
});

describe("GET /api/reports/rma-recovery", () => {
  it("renders credited parts with a total and rejected parts at zero credit", async () => {
    const { status, text } = await csvBody(`/api/reports/rma-recovery?from=${FROM}&to=${TO}`);
    expect(status).toBe(200);
    expect(text).toBe(
      csv(
        `RMA recovery,${FROM},${TO}`,
        `Credited parts`,
        `RMA order,Completed at,Serial,SKU,Credit,Note`,
        `RMA #2,2026-09-15T09:00:00.000Z,${scenario.batterySerials[2]},"Battery, Pro ""Max""",45.50,vendor credit`,
        `Total,,,,45.50`,
        ``,
        `Rejected parts (no credit)`,
        `RMA order,Completed at,Serial,SKU,Credit,Note`,
        `RMA #2,2026-09-15T09:00:00.000Z,${scenario.batterySerials[3]},"Battery, Pro ""Max""",0.00,refused by vendor`,
        `Total,,,,0.00`,
      ),
    );
  });
});

describe("GET /api/reports/batches-completed", () => {
  it("lists batches closed in the interval with device outcome counts", async () => {
    const { status, text } = await csvBody(`/api/reports/batches-completed?from=${FROM}&to=${TO}`);
    expect(status).toBe(200);
    expect(text).toBe(
      csv(
        `Batches completed,${FROM},${TO}`,
        `Batch,Closed at,Closed by,Repaired,Unrepairable,Additional issues (retriaged),Denied,Total devices`,
        `Batch #2,2026-09-10T12:00:00.000Z,tech@acme.co,2,0,0,0,2`,
        `Batch #3,2026-09-18T09:00:00.000Z,tech2@acme.co,1,0,1,0,2`,
        `Total,,,3,0,1,0,4`,
      ),
    );
  });
});

describe("GET /api/reports/shrink", () => {
  it("separates tech-attributed damage from audit failures and totals the loss", async () => {
    const { status, text } = await csvBody(`/api/reports/shrink?from=${FROM}&to=${TO}`);
    expect(status).toBe(200);
    expect(text).toBe(
      csv(
        `Shrink,${FROM},${TO}`,
        `Damaged by tech`,
        `Date,Serial,SKU,Tech,Batch,Price`,
        `2026-09-18T15:00:00.000Z,${scenario.batterySerials[8]},"Battery, Pro ""Max""",tech2@acme.co,,45.00`,
        `Total,,,,,45.00`,
        ``,
        `Audit failures`,
        `Date,Serial,SKU,Audit,Closed by,Price`,
        `2026-09-23T09:00:00.000Z,${scenario.batterySerials[4]},"Battery, Pro ""Max""",Audit #1,manager@acme.co,45.00`,
        `Total,,,,,45.00`,
        ``,
        `Totals`,
        `Cause,Price`,
        `Damaged by tech,45.00`,
        `Audit failure,45.00`,
        `Total,90.00`,
      ),
    );
  });
});

describe("GET /api/reports/tech-stats", () => {
  it("counts repairs, average repair time, and attributed damage per tech", async () => {
    const { status, text } = await csvBody(`/api/reports/tech-stats?from=${FROM}&to=${TO}`);
    expect(status).toBe(200);
    expect(text).toBe(
      csv(
        `Per-tech stats,${FROM},${TO}`,
        `Tech,Repairs completed,Average repair time (minutes),Damage attributed`,
        `tech2@acme.co,0,,1`,
        `tech@acme.co,3,60.0,0`,
        `Total,3,60.0,1`,
      ),
    );
  });
});

describe("CSV download mechanics", () => {
  it("serves a downloadable text/csv attachment", async () => {
    const { headers } = await csvBody(`/api/reports/expenses?from=${FROM}&to=${TO}`);
    expect(headers["content-type"]).toMatch(/^text\/csv/);
    expect(headers["content-disposition"]).toBe(`attachment; filename="expenses_${FROM}_${TO}.csv"`);
  });
});

describe("date-range validation is loud", () => {
  const cases: Array<[string, string]> = [
    ["missing from", `/api/reports/expenses?to=${TO}`],
    ["missing to", `/api/reports/expenses?from=${FROM}`],
    ["non-ISO from", `/api/reports/expenses?from=09/01/2026&to=${TO}`],
    ["not a real date", `/api/reports/expenses?from=2026-02-30&to=${TO}`],
    ["month out of range", `/api/reports/expenses?from=2026-13-01&to=${TO}`],
    ["from after to", `/api/reports/expenses?from=${TO}&to=${FROM}`],
  ];
  for (const [label, path] of cases) {
    it(`rejects ${label} with 400`, async () => {
      const response = await scenario.manager.agent.get(path);
      expect(response.status).toBe(400);
      expect(typeof (response.body as { error: string }).error).toBe("string");
    });
  }
});

describe("reports are manager-only", () => {
  it("a tech gets 403 on every report", async () => {
    for (const report of ["expenses", "rma-recovery", "batches-completed", "shrink", "tech-stats"]) {
      const response = await scenario.tech1.agent.get(`/api/reports/${report}?from=${FROM}&to=${TO}`);
      expect(response.status).toBe(403);
    }
  });
});
