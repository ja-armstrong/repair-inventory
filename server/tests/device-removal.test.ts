import { afterEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

/**
 * Tickets 30 + 02: removal freedom.
 *
 * Rule 1 (part removal): on a live batch (Awaiting approval or Open) ANY
 * tech may remove parts from ANY device — post-approval included, and from
 * terminal-but-not-absorbing devices (Repaired / Unrepairable / Additional
 * issues present). A removal only ever reduces cost, so it is never
 * manager-gated; the note is required and the standing approval is amended
 * in place. Only a CLOSED batch refuses: its record is finished. Ticket 02
 * also makes the destination ALWAYS explicit — no Buybackable default.
 *
 * Rule 2 (device removal): any tech may remove a NON-TERMINAL device from an
 * Awaiting-approval or Open batch. Its active attachments return to stock
 * (Available), its open Need to Order demand is cancelled, and the row leaves
 * the batch's counts, costs, approvals, and searches — but the row and its
 * events stay for cross-batch history. A Closed batch refuses: its record is
 * finished.
 */

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

const SCREEN = { name: "iPhone 13 Screen", price: "109.99", kind: "serialized" };
const BATTERY = { name: "iPhone 13 Battery", price: "39.50", kind: "serialized" };

interface SkuJson {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
  priceCents: number;
}

async function createSku(agent: Agent, overrides: Record<string, unknown> = {}): Promise<SkuJson> {
  const response = await agent.post("/api/skus").send({ ...SCREEN, ...overrides });
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

async function createBatch(agent: Agent): Promise<{ id: number; number: number }> {
  const response = await agent.post("/api/batches").send({ note: "Batch opened for triage" });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function addDevice(
  agent: Agent,
  batchId: number,
  overrides: Record<string, unknown> = {}
): Promise<{ id: number; deviceNumber: number | null }> {
  const response = await agent
    .post(`/api/batches/${batchId}/devices`)
    .send({
      modelName: "iPhone 13",
      statedIssue: "Cracked screen",
      imei: "359175920074058",
      ...overrides,
    });
  expect(response.status).toBe(201);
  return response.body as { id: number; deviceNumber: number | null };
}

async function addPart(
  agent: Agent,
  batchId: number,
  deviceId: number,
  body: Record<string, unknown>
): Promise<{ status: number; body: any }> {
  const response = await agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/parts`)
    .send(body);
  return { status: response.status, body: response.body };
}

/** Reserve one unit; returns { attachmentId, serial }. */
async function attachPart(agent: Agent, batchId: number, deviceId: number, skuId: number) {
  const added = await addPart(agent, batchId, deviceId, { skuId });
  expect(added.status).toBe(201);
  expect(added.body.outcome).toBe("reserved");
  return {
    attachmentId: added.body.attachment.id as number,
    serial: added.body.attachment.part.serial as string,
  };
}

/** File demand on an out-of-stock SKU; returns the demand id. */
async function fileDemand(agent: Agent, batchId: number, deviceId: number, skuId: number) {
  const added = await addPart(agent, batchId, deviceId, { skuId });
  expect(added.status).toBe(201);
  expect(added.body.outcome).toBe("need_to_order");
  return added.body.demand.id as number;
}

async function setStatus(agent: Agent, batchId: number, deviceId: number, repairStatus: string, resolutionNotes?: string) {
  return agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/status`)
    .send({ repairStatus, ...(resolutionNotes ? { resolutionNotes } : {}) });
}

async function decideApproved(manager: Agent, batchId: number, deviceId: number) {
  const response = await manager
    .post(`/api/batches/${batchId}/devices/${deviceId}/approval`)
    .send({ decision: "approved" });
  expect(response.status).toBe(200);
}

async function approveBatch(manager: Agent, batchId: number): Promise<any> {
  const response = await manager.post(`/api/batches/${batchId}/approve`).send({ note: "Costs look right" });
  return response;
}

function removePart(agent: Agent, batchId: number, deviceId: number, attachmentId: number, body: Record<string, unknown>) {
  return agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/parts/${attachmentId}/remove`)
    .send(body);
}

function removeDevice(agent: Agent, batchId: number, deviceId: number, body: Record<string, unknown> = {}) {
  return agent.post(`/api/batches/${batchId}/devices/${deviceId}/remove`).send(body);
}

async function partStatus(agent: Agent, serial: string): Promise<string> {
  const response = await agent.get(`/api/parts/${encodeURIComponent(serial)}`);
  expect(response.status).toBe(200);
  return response.body.status as string;
}

function actionsOf(harness: TestHarness, batchId: number): string[] {
  return (
    harness.db
      .prepare(
        `SELECT e.action FROM events e
          WHERE (e.entity_type = 'batch' AND e.entity_id = ?)
             OR (e.entity_type = 'device' AND e.entity_id IN (SELECT id FROM devices WHERE batch_id = ?))
             OR (e.entity_type = 'demand' AND e.entity_id IN (SELECT id FROM demand_records WHERE batch_id = ?))`
      )
      .all(batchId, batchId, batchId) as Array<{ action: string }>
  ).map((row) => row.action);
}

/** A tech-owned Open batch: device decided+approved, one reserved screen. */
async function openBatchWithPart() {
  const harness = createTestHarness();
  const tech = await harness.createUserAs("tech@acme.co", "tech");
  const manager = await harness.loginAs(MANAGER);
  const sku = await createSku(tech.agent);
  await intakeParts(tech.agent, sku.id, 2);
  const batch = await createBatch(tech.agent);
  const device = await addDevice(tech.agent, batch.id);
  const { attachmentId, serial } = await attachPart(tech.agent, batch.id, device.id, sku.id);
  return { harness, tech, manager, sku, batch, device, attachmentId, serial };
}

describe("post-approval part removal from any device (tickets 30 + 02)", () => {
  let harness: TestHarness;
  afterEach(() => harness?.close());

  it("a tech removes a part from a Parts-needed device on an Open batch; the approval is amended by the tech", async () => {
    const setup = await openBatchWithPart();
    harness = setup.harness;
    // A second, out-of-stock SKU blocks the device in Parts needed.
    const battery = await createSku(setup.tech.agent, BATTERY);
    await fileDemand(setup.tech.agent, setup.batch.id, setup.device.id, battery.id);

    await decideApproved(setup.manager.agent, setup.batch.id, setup.device.id);
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);

    const removed = await removePart(setup.tech.agent, setup.batch.id, setup.device.id, setup.attachmentId, {
      destination: "available",
      note: "screen is fine again — giving it back while we await the battery",
    });
    expect(removed.status).toBe(200);
    expect(removed.body.attachment.removedTo).toBe("available");
    expect(removed.body.attachment.removalReason).toBe("removal");
    expect(await partStatus(setup.tech.agent, setup.serial)).toBe("available");

    // The signed-off total moved (109.99 → 0) and the amendment carries the
    // tech's actor — removals amend regardless of role.
    const amended = harness.db
      .prepare("SELECT actor_id, payload FROM events WHERE action = 'batch.approval_amended' ORDER BY id DESC LIMIT 1")
      .get() as { actor_id: number; payload: string };
    expect(amended.actor_id).toBe(setup.tech.user.id);
    expect(JSON.parse(amended.payload)).toMatchObject({ previousTotalCents: 10999, totalCents: 0 });
    const batchRow = harness.db
      .prepare("SELECT approved_cost_cents FROM batches WHERE id = ?")
      .get(setup.batch.id) as { approved_cost_cents: number };
    expect(batchRow.approved_cost_cents).toBe(0);
    // The device stays blocked — removing a part does not unblock it.
    const detail = (await setup.tech.agent.get(`/api/batches/${setup.batch.id}`)).body;
    expect(detail.devices[0].repairStatus).toBe("Parts needed");
  });

  it("a tech removes from any device on an Open batch — Awaiting repair, post-approval included (ticket 02)", async () => {
    const setup = await openBatchWithPart();
    harness = setup.harness;
    await decideApproved(setup.manager.agent, setup.batch.id, setup.device.id);
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);

    // Awaiting repair — not Parts needed — and the tech still removes:
    // recovery is a tech decision, never automatic and never manager-gated.
    const removed = await removePart(setup.tech.agent, setup.batch.id, setup.device.id, setup.attachmentId, {
      destination: "available",
      note: "screen was fine — wrong part reserved",
    });
    expect(removed.status).toBe(200);
    expect(removed.body.attachment.removedTo).toBe("available");
    expect(await partStatus(setup.tech.agent, setup.serial)).toBe("available");

    // The signed-off total moved (109.99 → 0) and the amendment carries the
    // tech's actor — removals amend regardless of role.
    const amended = harness.db
      .prepare("SELECT actor_id, payload FROM events WHERE action = 'batch.approval_amended' ORDER BY id DESC LIMIT 1")
      .get() as { actor_id: number; payload: string };
    expect(amended.actor_id).toBe(setup.tech.user.id);
    expect(JSON.parse(amended.payload)).toMatchObject({ previousTotalCents: 10999, totalCents: 0 });
    const batchRow = harness.db
      .prepare("SELECT approved_cost_cents FROM batches WHERE id = ?")
      .get(setup.batch.id) as { approved_cost_cents: number };
    expect(batchRow.approved_cost_cents).toBe(0);
  });

  it("a tech removes from a TERMINAL device on an Open batch — the removal relaxation (ticket 02)", async () => {
    const setup = await openBatchWithPart();
    harness = setup.harness;
    await decideApproved(setup.manager.agent, setup.batch.id, setup.device.id);
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);
    expect(
      (await setStatus(setup.tech.agent, setup.batch.id, setup.device.id, "In progress")).status
    ).toBe(200);
    expect(
      (await setStatus(setup.tech.agent, setup.batch.id, setup.device.id, "Repaired", "done")).status
    ).toBe(200);

    // Terminal-but-not-absorbing: the part is still recoverable by a tech.
    const removed = await removePart(setup.tech.agent, setup.batch.id, setup.device.id, setup.attachmentId, {
      destination: "available",
      note: "part was never used — recover it",
    });
    expect(removed.status).toBe(200);
    expect(await partStatus(setup.tech.agent, setup.serial)).toBe("available");
    // No device status change rode along — the device stays terminal.
    const detail = (await setup.tech.agent.get(`/api/batches/${setup.batch.id}`)).body;
    expect(detail.devices[0].repairStatus).toBe("Repaired");
  });

  it("a CLOSED batch refuses part removal outright (ticket 02)", async () => {
    const setup = await openBatchWithPart();
    harness = setup.harness;
    await decideApproved(setup.manager.agent, setup.batch.id, setup.device.id);
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);
    expect(
      (await setStatus(setup.tech.agent, setup.batch.id, setup.device.id, "In progress")).status
    ).toBe(200);
    expect(
      (await setStatus(setup.tech.agent, setup.batch.id, setup.device.id, "Repaired", "done")).status
    ).toBe(200);
    expect((await setup.tech.agent.post(`/api/batches/${setup.batch.id}/close`).send({})).status).toBe(200);

    const refused = await removePart(setup.tech.agent, setup.batch.id, setup.device.id, setup.attachmentId, {
      destination: "available",
      note: "too late",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Closed");
  });

  it("the removal still requires its destination and note — every SKU, no defaults (ticket 02)", async () => {
    const setup = await openBatchWithPart();
    harness = setup.harness;
    const battery = await createSku(setup.tech.agent, BATTERY);
    await fileDemand(setup.tech.agent, setup.batch.id, setup.device.id, battery.id);
    await decideApproved(setup.manager.agent, setup.batch.id, setup.device.id);
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);

    const noNote = await removePart(setup.tech.agent, setup.batch.id, setup.device.id, setup.attachmentId, {
      destination: "available",
    });
    expect(noNote.status).toBe(400);
    const noDestination = await removePart(setup.tech.agent, setup.batch.id, setup.device.id, setup.attachmentId, {
      note: "no destination given",
    });
    expect(noDestination.status).toBe(400);
  });
});

describe("cancelling a Need to Order record (ticket 30)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;
  let manager: LoggedInAgent;

  async function setupDemandOnDevice() {
    const battery = await createSku(tech.agent, BATTERY);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id);
    const demandId = await fileDemand(tech.agent, batch.id, device.id, battery.id);
    return { battery, batch, device, demandId };
  }

  function cancelDemand(agent: Agent, batchId: number, deviceId: number, demandId: number, body: Record<string, unknown>) {
    return agent
      .post(`/api/batches/${batchId}/devices/${deviceId}/demand/${demandId}/cancel`)
      .send(body);
  }

  it("pre-approval: a tech cancels the demand; then the device unblocks to Awaiting repair", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupDemandOnDevice();

    const cancelled = await cancelDemand(tech.agent, s.batch.id, s.device.id, s.demandId, {
      note: "customer dropped the repair",
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.demand.status).toBe("cancelled");
    const row = harness.db
      .prepare("SELECT status, cancelled_by, cancelled_at FROM demand_records WHERE id = ?")
      .get(s.demandId) as { status: string; cancelled_by: number; cancelled_at: string };
    expect(row.status).toBe("cancelled");
    expect(row.cancelled_by).toBe(tech.user.id);
    expect(row.cancelled_at).not.toBeNull();

    // Gone from the outstanding queue; the device is still Parts needed until
    // a human says otherwise — but now it CAN say so.
    const outstanding = (await tech.agent.get("/api/demand")).body as { demand: Array<{ id: number }> };
    expect(outstanding.demand.find((record) => record.id === s.demandId)).toBeUndefined();
    let detail = (await tech.agent.get(`/api/batches/${s.batch.id}`)).body;
    expect(detail.devices[0].repairStatus).toBe("Parts needed");
    expect(detail.devices[0].allowedNextStatuses).toContain("Awaiting repair");

    expect((await setStatus(tech.agent, s.batch.id, s.device.id, "Awaiting repair")).status).toBe(200);
    detail = (await tech.agent.get(`/api/batches/${s.batch.id}`)).body;
    expect(detail.devices[0].repairStatus).toBe("Awaiting repair");
    const actions = actionsOf(harness, s.batch.id);
    expect(actions).toContain("demand.cancelled");
    expect(actions).toContain("device.demand_cancelled");
  });

  it("post-approval: a tech cancels the demand on a Parts-needed device of an Open batch", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupDemandOnDevice();
    await decideApproved(manager.agent, s.batch.id, s.device.id);
    expect((await approveBatch(manager.agent, s.batch.id)).status).toBe(200);

    expect((await cancelDemand(tech.agent, s.batch.id, s.device.id, s.demandId, { note: "repair cancelled" })).status).toBe(200);
    // The standing approval is untouched — a demand is an estimate, not a cost.
    const amended = harness.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE action = 'batch.approval_amended'")
      .get() as { n: number };
    expect(amended.n).toBe(0);
    // And the device proceeds: Parts needed → In progress was always the exit.
    expect((await setStatus(tech.agent, s.batch.id, s.device.id, "In progress")).status).toBe(200);
  });

  it("unblocking is refused while an open demand remains — Parts needed means blocked", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupDemandOnDevice();

    const blocked = await setStatus(tech.agent, s.batch.id, s.device.id, "Awaiting repair");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("Need to Order");

    expect((await cancelDemand(tech.agent, s.batch.id, s.device.id, s.demandId, { note: "gone" })).status).toBe(200);
    expect((await setStatus(tech.agent, s.batch.id, s.device.id, "Awaiting repair")).status).toBe(200);
  });

  it("refusals: note required, unknown/mismatched demand 404, double cancel 409, Closed batch 409", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupDemandOnDevice();
    const other = await setupBlockedOnSameSku(tech.agent, s.battery.id);

    expect((await cancelDemand(tech.agent, s.batch.id, s.device.id, s.demandId, {})).status).toBe(400);
    expect((await cancelDemand(tech.agent, s.batch.id, s.device.id, 9999, { note: "x" })).status).toBe(404);
    // The demand belongs to the OTHER device — mismatch 404s, it is not this device's record.
    expect((await cancelDemand(tech.agent, s.batch.id, other.deviceId, s.demandId, { note: "x" })).status).toBe(404);

    expect((await cancelDemand(tech.agent, s.batch.id, s.device.id, s.demandId, { note: "gone" })).status).toBe(200);
    const again = await cancelDemand(tech.agent, s.batch.id, s.device.id, s.demandId, { note: "again" });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("cancelled");

    // Closed batch: its record is finished.
    const closedBatch = await createBatch(tech.agent);
    const closedDevice = await addDevice(tech.agent, closedBatch.id, { imei: "999999999999999" });
    const closedDemand = await fileDemand(tech.agent, closedBatch.id, closedDevice.id, s.battery.id);
    await decideApproved(manager.agent, closedBatch.id, closedDevice.id);
    expect((await approveBatch(manager.agent, closedBatch.id)).status).toBe(200);
    expect((await setStatus(tech.agent, closedBatch.id, closedDevice.id, "In progress")).status).toBe(200);
    expect((await setStatus(tech.agent, closedBatch.id, closedDevice.id, "Unrepairable", "board dead")).status).toBe(200);
    expect((await tech.agent.post(`/api/batches/${closedBatch.id}/close`).send({})).status).toBe(200);
    const afterClose = await cancelDemand(tech.agent, closedBatch.id, closedDevice.id, closedDemand, { note: "too late" });
    expect(afterClose.status).toBe(409);
    expect(afterClose.body.error).toContain("Closed");
  });
});

/** A second device with its own open demand on the same SKU (mismatch fixture). */
async function setupBlockedOnSameSku(agent: Agent, skuId: number) {
  const batch = await createBatch(agent);
  const device = await addDevice(agent, batch.id, { imei: "444444444444444" });
  const demandId = await fileDemand(agent, batch.id, device.id, skuId);
  return { batchId: batch.id, deviceId: device.id, demandId };
}

describe("per-batch device numbers (ticket 30)", () => {
  let harness: TestHarness;
  afterEach(() => harness?.close());

  it("numbers devices 1..n within a batch; a removed device's number is never reused", async () => {
    harness = createTestHarness();
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const batch = await createBatch(tech.agent);
    const one = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const two = await addDevice(tech.agent, batch.id, { imei: "222222222222222" });
    const three = await addDevice(tech.agent, batch.id, { imei: "333333333333333" });
    // serializeDevice carries the number as deviceNumber.
    expect([one.deviceNumber, two.deviceNumber, three.deviceNumber]).toEqual([1, 2, 3]);
    // A second batch numbers independently.
    const otherBatch = await createBatch(tech.agent);
    const other = await addDevice(tech.agent, otherBatch.id, { imei: "444444444444444" });
    expect(other.deviceNumber).toBe(1);

    expect((await removeDevice(tech.agent, batch.id, two.id, { note: "mis-triaged" })).status).toBe(200);
    const four = await addDevice(tech.agent, batch.id, { imei: "555555555555555" });
    expect(four.deviceNumber).toBe(4); // #2 stays #2 in history — never reissued
    const detail = (await tech.agent.get(`/api/batches/${batch.id}`)).body;
    expect(detail.devices.map((device: { deviceNumber: number }) => device.deviceNumber)).toEqual([1, 3, 4]);
  });

  it("a retriaged continuation row starts the new batch's numbering", async () => {
    harness = createTestHarness();
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const manager = await harness.loginAs(MANAGER);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    await decideApproved(manager.agent, batch.id, device.id);
    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);
    expect((await setStatus(tech.agent, batch.id, device.id, "In progress")).status).toBe(200);
    const retriaged = await setStatus(
      tech.agent,
      batch.id,
      device.id,
      "Additional issues present",
      "water damage found"
    );
    expect(retriaged.status).toBe(200);
    const retriagedTo = retriaged.body.retriagedTo as { batchId: number };
    const row = (await tech.agent.get(`/api/batches/${retriagedTo.batchId}`)).body;
    expect(row.devices[0].deviceNumber).toBe(1);
  });
});

describe("removing a device from a batch (ticket 30)", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;
  let manager: LoggedInAgent;

  async function setupBlockedDevice() {
    const screen = await createSku(tech.agent);
    await intakeParts(tech.agent, screen.id, 2);
    const battery = await createSku(tech.agent, BATTERY);
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id);
    const { attachmentId, serial } = await attachPart(tech.agent, batch.id, device.id, screen.id);
    const demandId = await fileDemand(tech.agent, batch.id, device.id, battery.id);
    return { screen, battery, batch, device, attachmentId, serial, demandId };
  }

  it("pre-approval: parts return to stock, open demand is cancelled, the row leaves the batch", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupBlockedDevice();

    const removed = await removeDevice(tech.agent, s.batch.id, s.device.id, {
      note: "customer took the device back — repair cancelled",
    });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ deviceId: s.device.id, returnedParts: 1, cancelledDemand: 1 });

    // The reserved screen unit is Available again, with a truthful removal record.
    expect(await partStatus(tech.agent, s.serial)).toBe("available");
    const attachment = harness.db
      .prepare("SELECT removed_at, removed_to, removal_note, removal_reason FROM device_parts WHERE id = ?")
      .get(s.attachmentId) as { removed_at: string; removed_to: string; removal_note: string; removal_reason: string };
    expect(attachment.removed_at).not.toBeNull();
    expect(attachment.removed_to).toBe("available");
    expect(attachment.removal_reason).toBe("removal");
    expect(attachment.removal_note).toContain("customer took the device back");

    // The demand record is cancelled — no longer outstanding anywhere.
    const demandRow = harness.db
      .prepare("SELECT status, cancelled_by FROM demand_records WHERE id = ?")
      .get(s.demandId) as { status: string; cancelled_by: number };
    expect(demandRow.status).toBe("cancelled");
    expect(demandRow.cancelled_by).toBe(tech.user.id);
    const outstanding = (await tech.agent.get("/api/demand")).body as { demand: Array<{ id: number }> };
    expect(outstanding.demand.find((record) => record.id === s.demandId)).toBeUndefined();

    // The device leaves the batch grid, the counts, and the parts listing.
    const detail = (await tech.agent.get(`/api/batches/${s.batch.id}`)).body;
    expect(detail.devices).toHaveLength(0);
    expect(detail.deviceTotal).toBe(0);
    const parts = (await tech.agent.get(`/api/batches/${s.batch.id}/parts`)).body as { devices: unknown[] };
    expect(parts.devices).toHaveLength(0);

    // The row remains — history is not deleted.
    const deviceRow = harness.db
      .prepare("SELECT removed_at, removed_by, removal_note FROM devices WHERE id = ?")
      .get(s.device.id) as { removed_at: string; removed_by: number; removal_note: string };
    expect(deviceRow.removed_at).not.toBeNull();
    expect(deviceRow.removed_by).toBe(tech.user.id);
    expect(deviceRow.removal_note).toContain("customer took the device back");

    const actions = actionsOf(harness, s.batch.id);
    expect(actions).toContain("device.removed");
    expect(actions).toContain("demand.cancelled");
  });

  it("a note is required, an unknown device 404s, and a second removal 404s", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupBlockedDevice();

    expect((await removeDevice(tech.agent, s.batch.id, s.device.id, {})).status).toBe(400);
    expect((await removeDevice(tech.agent, s.batch.id, s.device.id, { note: "   " })).status).toBe(400);
    expect((await removeDevice(tech.agent, s.batch.id, 9999, { note: "ghost" })).status).toBe(404);

    expect((await removeDevice(tech.agent, s.batch.id, s.device.id, { note: "gone" })).status).toBe(200);
    expect((await removeDevice(tech.agent, s.batch.id, s.device.id, { note: "again" })).status).toBe(404);
  });

  it("terminal devices refuse removal — their run is part of the batch's record", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupBlockedDevice();
    await decideApproved(manager.agent, s.batch.id, s.device.id);
    expect((await approveBatch(manager.agent, s.batch.id)).status).toBe(200);
    expect((await setStatus(tech.agent, s.batch.id, s.device.id, "In progress")).status).toBe(200);
    expect((await setStatus(tech.agent, s.batch.id, s.device.id, "Repaired", "screen swapped")).status).toBe(200);

    const refused = await removeDevice(tech.agent, s.batch.id, s.device.id, { note: "too late" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("terminal");
  });

  it("a Closed batch refuses device removal outright", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupBlockedDevice();
    await decideApproved(manager.agent, s.batch.id, s.device.id);
    expect((await approveBatch(manager.agent, s.batch.id)).status).toBe(200);
    // The reserved unit is consumed; the battery demand is moot — end the device.
    expect((await setStatus(tech.agent, s.batch.id, s.device.id, "In progress")).status).toBe(200);
    expect((await setStatus(tech.agent, s.batch.id, s.device.id, "Unrepairable", "board dead")).status).toBe(200);
    expect((await tech.agent.post(`/api/batches/${s.batch.id}/close`).send({})).status).toBe(200);

    const refused = await removeDevice(tech.agent, s.batch.id, s.device.id, { note: "cleaning up" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Closed");
  });

  it("post-approval: device removal amends the approved total by excluding the device", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupBlockedDevice();
    const deviceB = await addDevice(tech.agent, s.batch.id, { imei: "222222222222222" });
    await attachPart(tech.agent, s.batch.id, deviceB.id, s.screen.id); // second screen: 109.99

    await decideApproved(manager.agent, s.batch.id, s.device.id);
    await decideApproved(manager.agent, s.batch.id, deviceB.id);
    const approved = await approveBatch(manager.agent, s.batch.id);
    expect(approved.status).toBe(200);
    expect(approved.body.approvedCostCents).toBe(21998);

    const removed = await removeDevice(tech.agent, s.batch.id, s.device.id, { note: "customer took it back" });
    expect(removed.status).toBe(200);
    const amended = harness.db
      .prepare("SELECT actor_id, payload FROM events WHERE action = 'batch.approval_amended' ORDER BY id DESC LIMIT 1")
      .get() as { actor_id: number; payload: string };
    expect(amended.actor_id).toBe(tech.user.id);
    expect(JSON.parse(amended.payload)).toMatchObject({ previousTotalCents: 21998, totalCents: 10999 });
    const batchRow = harness.db
      .prepare("SELECT approved_cost_cents FROM batches WHERE id = ?")
      .get(s.batch.id) as { approved_cost_cents: number };
    expect(batchRow.approved_cost_cents).toBe(10999);
  });

  it("approval decisions only concern live devices — a removed device never blocks approval", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupBlockedDevice();
    const deviceB = await addDevice(tech.agent, s.batch.id, { imei: "222222222222222" });
    await attachPart(tech.agent, s.batch.id, deviceB.id, s.screen.id);

    await decideApproved(manager.agent, s.batch.id, deviceB.id);
    const blocked = await approveBatch(manager.agent, s.batch.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("no approval decision");

    expect((await removeDevice(tech.agent, s.batch.id, s.device.id, { note: "gone" })).status).toBe(200);
    const approved = await approveBatch(manager.agent, s.batch.id);
    expect(approved.status).toBe(200);
    // The removed device's screen returned to stock, so only device B's screen is signed off.
    expect(approved.body.approvedCostCents).toBe(10999);
  });

  it("a removed device no longer blocks closing", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupBlockedDevice();
    const deviceB = await addDevice(tech.agent, s.batch.id, { imei: "222222222222222" });
    await attachPart(tech.agent, s.batch.id, deviceB.id, s.screen.id);

    await decideApproved(manager.agent, s.batch.id, s.device.id);
    await decideApproved(manager.agent, s.batch.id, deviceB.id);
    expect((await approveBatch(manager.agent, s.batch.id)).status).toBe(200);

    expect((await setStatus(tech.agent, s.batch.id, deviceB.id, "In progress")).status).toBe(200);
    expect((await setStatus(tech.agent, s.batch.id, deviceB.id, "Repaired", "fixed")).status).toBe(200);
    // s.device sits in Parts needed — still active — so close refuses it by name.
    const blocked = await tech.agent.post(`/api/batches/${s.batch.id}/close`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("Parts needed");

    expect((await removeDevice(tech.agent, s.batch.id, s.device.id, { note: "walked out" })).status).toBe(200);
    const closed = await tech.agent.post(`/api/batches/${s.batch.id}/close`).send({});
    expect(closed.status).toBe(200);
  });

  it("search stops finding the removed device but cross-batch history keeps its rows", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupBlockedDevice();
    const otherBatch = await createBatch(tech.agent);
    const other = await addDevice(tech.agent, otherBatch.id, { imei: "359175920074058" });

    expect((await removeDevice(tech.agent, s.batch.id, s.device.id, { note: "mis-triaged" })).status).toBe(200);

    const search = (await tech.agent.get("/api/search?q=359175920074058")).body as {
      results: { devices: Array<{ id: number }> };
    };
    expect(search.results.devices.find((row) => row.id === s.device.id)).toBeUndefined();
    // The OTHER batch's row still matches (and the history chain sees the removed row).
    const history = (await tech.agent.get(`/api/batches/${otherBatch.id}/devices/${other.id}/history`)).body as {
      history: Array<{ id: number }>;
    };
    expect(history.history.find((row) => row.id === s.device.id)).toBeDefined();
  });

  it("cancelled demand cannot be marked ordered on a PO; and a received part does not auto-reserve onto a removed device", async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
    tech = await harness.createUserAs("tech@acme.co", "tech");
    const s = await setupBlockedDevice();

    // A demand is orderable only from an APPROVED (Open) batch (ticket 09 /
    // spec decision 9: a pre-approval demand is an estimate), so the batch
    // is approved before the PO is created. Removing the device afterwards
    // is allowed on an Open batch (ticket 02) and cancels the open demand.
    await decideApproved(manager.agent, s.batch.id, s.device.id);
    expect((await approveBatch(manager.agent, s.batch.id)).status).toBe(200);

    // Order the demand BEFORE the removal — the PO link exists while demand is open.
    const created = await tech.agent.post("/api/purchase-orders").send({
      purpose: "Battery restock",
      note: "ordering the blocked battery",
      lines: [{ skuId: s.battery.id, quantity: 1, unitPrice: "39.50", demandId: s.demandId }],
    });
    expect(created.status).toBe(201);
    const po = created.body as { id: number };

    expect((await removeDevice(tech.agent, s.batch.id, s.device.id, { note: "customer cancelled" })).status).toBe(200);

    // Marking the CANCELLED demand on another PO is refused — only open demand orders.
    const refusedLine = await tech.agent.post("/api/purchase-orders").send({
      purpose: "Dup",
      note: "should not link cancelled demand",
      lines: [{ skuId: s.battery.id, quantity: 1, unitPrice: "39.50", demandId: s.demandId }],
    });
    expect(refusedLine.status).toBe(400);
    expect(refusedLine.body.error).toMatch(/open demand/i);

    // Receipt of the already-ordered PO: the demand is cancelled, so nothing
    // auto-reserves onto the removed device — the unit lands Available.
    const approved = await manager.agent
      .post(`/api/purchase-orders/${po.id}/approve`)
      .send({ note: "go" });
    expect(approved.status).toBe(200);
    const serial = approved.body.expectedSerials[0].serial as string;
    const received = await tech.agent
      .post(`/api/purchase-orders/${po.id}/receive`)
      .send({ serial });
    expect(received.status).toBe(200);
    expect(received.body.purchaseOrder.lines[0].demand.id).toBe(s.demandId);
    expect(await partStatus(tech.agent, serial)).toBe("available");
    const attachment = harness.db
      .prepare("SELECT COUNT(*) AS n FROM device_parts WHERE part_id = (SELECT id FROM serialized_parts WHERE serial = ?)")
      .get(serial) as { n: number };
    expect(attachment.n).toBe(0);
  });
});
