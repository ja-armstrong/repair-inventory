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
 * Ticket 25 — per-device approval and the Denied Repair terminal status
 * (CONTEXT.md: Approval, Denied Repair). While a batch is Awaiting approval
 * the manager decides each device; approving with an undecided device is
 * refused by name; rejected devices lose their parts (back to stock) and end
 * in Denied Repair; the approved cost covers approved devices only.
 */

const SCREEN = { name: "iPhone 13 Screen", price: "109.99", kind: "serialized" };

interface DeviceJson {
  id: number;
  model: { name: string };
  imei: string | null;
  repairStatus: string;
  resolutionNotes: string | null;
  approvalDecision: string | null;
  approvalDecisionNote: string | null;
  allowedNextStatuses: string[];
}

interface BatchJson {
  id: number;
  number: number;
  status: string;
  approvedCostCents: number | null;
  devices: DeviceJson[];
}

async function createSku(agent: Agent, overrides: Record<string, unknown> = {}) {
  const response = await agent.post("/api/skus").send({ ...SCREEN, ...overrides });
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

async function createBatch(agent: Agent) {
  const response = await agent.post("/api/batches").send({ note: "per-device approval" });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function addDevice(agent: Agent, batchId: number, imei: string, modelName = "iPhone 13") {
  const response = await agent
    .post(`/api/batches/${batchId}/devices`)
    .send({ modelName, statedIssue: "Cracked screen", imei });
  expect(response.status).toBe(201);
  return response.body as { id: number };
}

async function addPart(agent: Agent, batchId: number, deviceId: number, skuId: number) {
  const response = await agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/parts`)
    .send({ skuId });
  expect(response.status).toBe(201);
  return response.body as { outcome: string; attachment?: { id: number } };
}

async function batchDetail(agent: Agent, batchId: number): Promise<BatchJson> {
  const response = await agent.get(`/api/batches/${batchId}`);
  expect(response.status).toBe(200);
  return response.body as BatchJson;
}

async function decide(
  agent: Agent,
  batchId: number,
  deviceId: number,
  body: Record<string, unknown>
) {
  return agent.post(`/api/batches/${batchId}/devices/${deviceId}/approval`).send(body);
}

async function approveBatch(agent: Agent, batchId: number, note = "Costs look right") {
  return agent.post(`/api/batches/${batchId}/approve`).send({ note });
}

async function approveAll(agent: Agent, batchId: number) {
  return agent.post(`/api/batches/${batchId}/devices/approve-all`).send({});
}

describe("per-device approval decisions", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("is manager-only (a tech is refused)", async () => {
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, "359175920074058");
    const refused = await decide(tech.agent, batch.id, device.id, { decision: "approved" });
    expect(refused.status).toBe(403);
  });

  it("a rejection WITHOUT a note is accepted — the denial's record is the rejection event itself", async () => {
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");

    const noNote = await decide(manager.agent, batch.id, device.id, { decision: "rejected" });
    expect(noNote.status).toBe(200);
    expect((noNote.body as DeviceJson).approvalDecision).toBe("rejected");
    expect((noNote.body as DeviceJson).approvalDecisionNote).toBeNull();

    // A note given later (re-deciding is allowed until the batch opens)
    // becomes the denial's resolution notes at batch approval, as before.
    const withNote = await decide(manager.agent, batch.id, device.id, {
      decision: "rejected",
      note: "water damage, not worth it",
    });
    expect(withNote.status).toBe(200);
    expect((withNote.body as DeviceJson).approvalDecisionNote).toBe(
      "water damage, not worth it",
    );
  });

  it("records device.approval_decided events and is re-togglable — the latest decision wins", async () => {
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");

    const rejected = await decide(manager.agent, batch.id, device.id, {
      decision: "rejected",
      note: "water damage, not worth it",
    });
    expect(rejected.status).toBe(200);
    expect((rejected.body as DeviceJson).approvalDecision).toBe("rejected");

    const approved = await decide(manager.agent, batch.id, device.id, { decision: "approved" });
    expect(approved.status).toBe(200);
    expect((approved.body as DeviceJson).approvalDecision).toBe("approved");

    const events = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.approval_decided' ORDER BY id"
      )
      .all(device.id) as Array<{ payload: string }>;
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      decision: "rejected",
      note: "water damage, not worth it",
    });
    expect(JSON.parse(events[1].payload)).toMatchObject({ decision: "approved" });

    // The superseded rejection note is gone from the row (it never became
    // resolution notes — the device was approved after all).
    const row = harness.db
      .prepare("SELECT approval_decision, approval_decision_note FROM devices WHERE id = ?")
      .get(device.id) as { approval_decision: string; approval_decision_note: string | null };
    expect(row).toEqual({ approval_decision: "approved", approval_decision_note: null });
  });

  it("a noteless rejection still denies at batch approval — resolution notes stay empty, parts return to stock", async () => {
    const sku = await createSku(manager.agent);
    await intakeParts(manager.agent, sku.id, 1);
    const batch = await createBatch(manager.agent);
    const deniedDevice = await addDevice(manager.agent, batch.id, "356938035643809", "iPhone 12");
    await addPart(manager.agent, batch.id, deniedDevice.id, sku.id);
    await decide(manager.agent, batch.id, deniedDevice.id, { decision: "rejected" });
    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);

    const detail = await batchDetail(manager.agent, batch.id);
    const denied = detail.devices.find((device) => device.id === deniedDevice.id)!;
    expect(denied.repairStatus).toBe("Denied Repair");
    expect(denied.resolutionNotes).toBeNull();
    // The denial is still on the record: the status change names the reason.
    const statusEvent = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.status_changed' ORDER BY id DESC LIMIT 1"
      )
      .get(deniedDevice.id) as { payload: string };
    expect(JSON.parse(statusEvent.payload)).toMatchObject({
      from: "Awaiting repair",
      to: "Denied Repair",
      reason: "approval_rejected",
    });
    // And the part went back to stock, as every denial does.
    const attachment = harness.db
      .prepare(
        "SELECT removed_to FROM device_parts WHERE device_id = ? AND removed_at IS NOT NULL"
      )
      .get(deniedDevice.id) as { removed_to: string };
    expect(attachment.removed_to).toBe("available");
  });

  it("refuses decisions once the batch is Open — the per-device phase is over", async () => {
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");
    await decide(manager.agent, batch.id, device.id, { decision: "approved" });
    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);
    const refused = await decide(manager.agent, batch.id, device.id, { decision: "rejected", note: "late" });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain("Open");
  });
});

describe("approve all devices (bulk)", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("is manager-only (a tech is refused)", async () => {
    const batch = await createBatch(tech.agent);
    await addDevice(tech.agent, batch.id, "359175920074058");
    const refused = await approveAll(tech.agent, batch.id);
    expect(refused.status).toBe(403);
  });

  it("approves only UNDECIDED devices — earlier rejections and approvals are untouched", async () => {
    const batch = await createBatch(manager.agent);
    const approved = await addDevice(manager.agent, batch.id, "359175920074058");
    const rejected = await addDevice(manager.agent, batch.id, "356938035643809", "iPhone 12");
    const undecidedA = await addDevice(manager.agent, batch.id, "013844004567571", "iPhone 14");
    const undecidedB = await addDevice(manager.agent, batch.id, "358240051311245", "iPhone 15");
    await decide(manager.agent, batch.id, approved.id, { decision: "approved" });
    await decide(manager.agent, batch.id, rejected.id, { decision: "rejected", note: "board damage" });

    const response = await approveAll(manager.agent, batch.id);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ approved: 2 });

    const detail = await batchDetail(manager.agent, batch.id);
    const decisions = Object.fromEntries(
      detail.devices.map((device) => [device.id, device.approvalDecision]),
    );
    // Only the undecided pair was decided.
    expect(decisions[undecidedA.id]).toBe("approved");
    expect(decisions[undecidedB.id]).toBe("approved");
    expect(decisions[approved.id]).toBe("approved");
    expect(decisions[rejected.id]).toBe("rejected");

    // The rejected device keeps its note; the bulk-approved ones have none.
    const rows = harness.db
      .prepare("SELECT id, approval_decision, approval_decision_note FROM devices WHERE batch_id = ? ORDER BY id")
      .all(batch.id) as Array<{ id: number; approval_decision: string; approval_decision_note: string | null }>;
    expect(rows.find((row) => row.id === rejected.id)).toMatchObject({
      approval_decision: "rejected",
      approval_decision_note: "board damage",
    });
    expect(rows.find((row) => row.id === undecidedA.id)).toMatchObject({
      approval_decision: "approved",
      approval_decision_note: null,
    });

    // Each bulk decision records the standard per-device event.
    const events = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'device' AND action = 'device.approval_decided' AND entity_id IN (?, ?) ORDER BY id"
      )
      .all(undecidedA.id, undecidedB.id) as Array<{ payload: string }>;
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0].payload)).toMatchObject({
      decision: "approved",
      model: "iPhone 14",
      via: "approve_all",
    });
  });

  it("refuses when there is nothing left to decide — no silent success", async () => {
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");
    await decide(manager.agent, batch.id, device.id, { decision: "approved" });
    const refused = await approveAll(manager.agent, batch.id);
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain("no undecided devices");
  });

  it("refuses once the batch is Open — decisions belong to Awaiting approval", async () => {
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");
    await decide(manager.agent, batch.id, device.id, { decision: "approved" });
    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);

    // Re-open a decision surface by adding a device to the Open batch: the
    // bulk route must still refuse — the per-device phase is over.
    await addDevice(manager.agent, batch.id, "356938035643809", "iPhone 12");
    const refused = await approveAll(manager.agent, batch.id);
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain("Open");
  });

  it("the full flow: approve-all unblocks batch approval — the signed-off cost covers every device", async () => {
    const sku = await createSku(manager.agent);
    await intakeParts(manager.agent, sku.id, 2);
    const batch = await createBatch(manager.agent);
    const deviceA = await addDevice(manager.agent, batch.id, "359175920074058");
    const deviceB = await addDevice(manager.agent, batch.id, "356938035643809", "iPhone 12");
    await addPart(manager.agent, batch.id, deviceA.id, sku.id);
    await addPart(manager.agent, batch.id, deviceB.id, sku.id);

    expect((await approveBatch(manager.agent, batch.id)).status).toBe(409);
    expect((await approveAll(manager.agent, batch.id)).status).toBe(200);
    const approved = await approveBatch(manager.agent, batch.id);
    expect(approved.status).toBe(200);

    const detail = await batchDetail(manager.agent, batch.id);
    expect(detail.status).toBe("Open");
    expect(detail.approvedCostCents).toBe(2 * 10999);
  });
});

describe("batch approval with per-device decisions", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });

  afterEach(() => {
    harness.close();
  });

  it("refuses approval while any device is undecided — naming them", async () => {
    const sku = await createSku(manager.agent);
    await intakeParts(manager.agent, sku.id, 2);
    const batch = await createBatch(manager.agent);
    const decided = await addDevice(manager.agent, batch.id, "359175920074058");
    const undecided = await addDevice(manager.agent, batch.id, "356938035643809", "iPhone 12");
    await addPart(manager.agent, batch.id, decided.id, sku.id);
    await decide(manager.agent, batch.id, decided.id, { decision: "approved" });

    const refused = await approveBatch(manager.agent, batch.id);
    expect(refused.status).toBe(409);
    const error = (refused.body as { error: string }).error;
    expect(error).toContain("no approval decision");
    expect(error).toContain("iPhone 12");
    expect(error).toContain("356938035643809");
  });

  it("an empty batch still approves (every device decided is vacuous)", async () => {
    const batch = await createBatch(manager.agent);
    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);
  });

  it("approval applies the decisions: rejected → parts back to stock + Denied Repair; cost covers approved only", async () => {
    const sku = await createSku(manager.agent);
    const serials = await intakeParts(manager.agent, sku.id, 2);
    const batch = await createBatch(manager.agent);
    const approvedDevice = await addDevice(manager.agent, batch.id, "359175920074058");
    const deniedDevice = await addDevice(manager.agent, batch.id, "356938035643809", "iPhone 12");
    await addPart(manager.agent, batch.id, approvedDevice.id, sku.id);
    await addPart(manager.agent, batch.id, deniedDevice.id, sku.id);

    await decide(manager.agent, batch.id, approvedDevice.id, { decision: "approved" });
    await decide(manager.agent, batch.id, deniedDevice.id, {
      decision: "rejected",
      note: "board is corrosion-damaged beyond economic repair",
    });

    const approved = await approveBatch(manager.agent, batch.id);
    expect(approved.status).toBe(200);
    const detail = await batchDetail(manager.agent, batch.id);

    // The approved cost covers approved devices only.
    expect(detail.approvedCostCents).toBe(10999);

    const denied = detail.devices.find((device) => device.id === deniedDevice.id)!;
    expect(denied.repairStatus).toBe("Denied Repair");
    expect(denied.resolutionNotes).toBe("board is corrosion-damaged beyond economic repair");
    // Still close-eligible, but correctable: the one exit is back to
    // Awaiting repair (the accident correction — the denial is undone by
    // leaving it, and the part re-added through the normal flow).
    expect(denied.allowedNextStatuses).toEqual(["Awaiting repair"]);

    // The denied device's part went back to stock: Available, attachment
    // closed with the denial auto-note.
    const partRow = harness.db
      .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
      .get(serials[1]) as { status: string };
    expect(partRow.status).toBe("available");
    const attachment = harness.db
      .prepare(
        `SELECT dp.removed_to, dp.removal_note, dp.removal_reason
           FROM device_parts dp
          WHERE dp.device_id = ? AND dp.removed_at IS NOT NULL`
      )
      .get(deniedDevice.id) as {
      removed_to: string;
      removal_note: string;
      removal_reason: string;
    };
    expect(attachment).toEqual({
      removed_to: "available",
      removal_note: "repair denied at approval — parts returned to stock",
      removal_reason: "removal",
    });

    const partEvent = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'part' AND action = 'part.removed' ORDER BY id DESC LIMIT 1"
      )
      .get() as { payload: string };
    expect(JSON.parse(partEvent.payload)).toMatchObject({ reason: "batch_denied", to: "available" });

    const statusEvent = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.status_changed' ORDER BY id DESC LIMIT 1"
      )
      .get(deniedDevice.id) as { payload: string };
    expect(JSON.parse(statusEvent.payload)).toMatchObject({
      from: "Awaiting repair",
      to: "Denied Repair",
      reason: "approval_rejected",
    });

    const approvedEvent = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'batch' AND entity_id = ? AND action = 'batch.approved' ORDER BY id DESC LIMIT 1"
      )
      .get(batch.id) as { payload: string };
    expect(JSON.parse(approvedEvent.payload)).toMatchObject({
      totalCents: 10999,
      deniedDevices: [{ id: deniedDevice.id, returnedParts: 1 }],
    });

    // The approved device is untouched: part still reserved, status unmoved.
    const keepPart = harness.db
      .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
      .get(serials[0]) as { status: string };
    expect(keepPart.status).toBe("reserved");
    const kept = detail.devices.find((device) => device.id === approvedDevice.id)!;
    expect(kept.repairStatus).toBe("Awaiting repair");
  });

  it("Denied Repair cannot be set directly — no graph edge reaches it", async () => {
    const batch = await createBatch(manager.agent);
    const device = await addDevice(manager.agent, batch.id, "359175920074058");
    const direct = await manager.agent
      .post(`/api/batches/${batch.id}/devices/${device.id}/status`)
      .send({ repairStatus: "Denied Repair", resolutionNotes: "trying the side door" });
    expect(direct.status).toBe(409);
    expect((direct.body as { error: string }).error).toContain("Denied Repair");
  });

  it("a later amendment excludes the denied device's (nonexistent) cost — the approved device's part change moves the total", async () => {
    const sku = await createSku(manager.agent);
    await intakeParts(manager.agent, sku.id, 2);
    const batch = await createBatch(manager.agent);
    const approvedDevice = await addDevice(manager.agent, batch.id, "359175920074058");
    const deniedDevice = await addDevice(manager.agent, batch.id, "356938035643809", "iPhone 12");
    await addPart(manager.agent, batch.id, approvedDevice.id, sku.id);
    await addPart(manager.agent, batch.id, deniedDevice.id, sku.id);
    await decide(manager.agent, batch.id, approvedDevice.id, { decision: "approved" });
    await decide(manager.agent, batch.id, deniedDevice.id, { decision: "rejected", note: "denied" });
    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);

    // Manager amends: adds another part to the approved device.
    const added = await manager.agent
      .post(`/api/batches/${batch.id}/devices/${approvedDevice.id}/parts`)
      .send({ skuId: sku.id, note: "amending — second part needed" });
    expect(added.status).toBe(201);

    const detail = await batchDetail(manager.agent, batch.id);
    expect(detail.approvedCostCents).toBe(2 * 10999);
  });

  it("the batches-completed report counts Denied devices", async () => {
    const sku = await createSku(manager.agent);
    await intakeParts(manager.agent, sku.id, 2);
    const batch = await createBatch(manager.agent);
    const approvedDevice = await addDevice(manager.agent, batch.id, "359175920074058");
    const deniedDevice = await addDevice(manager.agent, batch.id, "356938035643809", "iPhone 12");
    await addPart(manager.agent, batch.id, approvedDevice.id, sku.id);
    await addPart(manager.agent, batch.id, deniedDevice.id, sku.id);
    await decide(manager.agent, batch.id, approvedDevice.id, { decision: "approved" });
    await decide(manager.agent, batch.id, deniedDevice.id, { decision: "rejected", note: "denied" });
    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);

    await manager.agent
      .post(`/api/batches/${batch.id}/devices/${approvedDevice.id}/status`)
      .send({ repairStatus: "In progress" });
    await manager.agent
      .post(`/api/batches/${batch.id}/devices/${approvedDevice.id}/status`)
      .send({ repairStatus: "Repaired", resolutionNotes: "screen replaced" });
    expect((await manager.agent.post(`/api/batches/${batch.id}/close`).send({})).status).toBe(200);

    const report = await manager.agent.get("/api/reports/batches-completed?from=2026-09-24&to=2026-09-24");
    expect(report.status).toBe(200);
    // The report is a CSV download; the Denied column sits between the
    // retriage count and the device total.
    const text = report.text as string;
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0]).toBe("Batches completed,2026-09-24,2026-09-24");
    expect(lines[1]).toBe(
      "Batch,Closed at,Closed by,Repaired,Unrepairable,Additional issues (retriaged),Denied,Total devices",
    );
    const dataRow = lines.find((line) => line.startsWith(`Batch #${batch.number},`))!;
    const cells = dataRow.split(",");
    expect(Number(cells[6])).toBe(1); // Denied
    expect(Number(cells[7])).toBe(2); // Total devices
  });
});
