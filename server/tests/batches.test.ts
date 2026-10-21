import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

interface DeviceJson {
  id: number;
  batchId: number;
  model: { id: number; name: string };
  capacity: string | null;
  assetId: string | null;
  imei: string | null;
  serialNumber: string | null;
  statedIssue: string;
  notes: string | null;
  repairTimeMinutes: number | null;
  repairStatus: string;
  resolutionNotes: string | null;
  allowedNextStatuses: string[];
  assignedTech: { id: number; email: string };
  triageDate: string;
  createdAt: string;
  updatedAt: string;
  warnings?: string[];
}

interface BatchJson {
  id: number;
  number: number;
  createdAt: string;
  createdBy: { id: number; email: string };
  status: string;
  openingNote: string;
  approvedAt: string | null;
  approvedBy: { id: number; email: string } | null;
  approvedCostCents: number | null;
  closedAt: string | null;
  closedBy: { id: number; email: string } | null;
  deviceCounts: Record<string, number>;
  deviceTotal: number;
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

const DEVICE_BASE = {
  modelName: "iPhone 13",
  statedIssue: "Cracked screen",
  imei: "359175920074058",
};

async function createBatch(harness: TestHarness, note = "Batch opened for triage") {
  const { agent } = await harness.loginAs(MANAGER);
  const response = await agent.post("/api/batches").send({ note });
  expect(response.status).toBe(201);
  return { agent, batch: response.body as BatchJson };
}

async function addDevice(agent: Agent, batchId: number, overrides: Record<string, unknown> = {}) {
  return agent.post(`/api/batches/${batchId}/devices`).send({ ...DEVICE_BASE, ...overrides });
}

async function setStatus(agent: Agent, batchId: number, deviceId: number, repairStatus: string, resolutionNotes?: string) {
  return agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/status`)
    .send(resolutionNotes === undefined ? { repairStatus } : { repairStatus, resolutionNotes });
}

/** Ticket 06: repair work starts only after the manager's cost sign-off. */
/**
 * Ticket 25: every device on an Awaiting-approval batch needs a manager's
 * decision before the batch can open. Legacy approval helpers decide every
 * undecided device as "approved" first — refusals (a tech's 403, an
 * already-Open batch) surface at the approve call itself, where the tests
 * assert them.
 */
async function decideAll(agent: Agent, batchId: number, decision: "approved" | "rejected" = "approved") {
  const detail = await agent.get(`/api/batches/${batchId}`);
  const devices = (detail.body as { devices: Array<{ id: number; approvalDecision: string | null }> }).devices;
  for (const device of devices) {
    if (device.approvalDecision === decision) {
      continue;
    }
    await agent
      .post(`/api/batches/${batchId}/devices/${device.id}/approval`)
      .send(decision === "rejected" ? { decision, note: "not repairable" } : { decision });
  }
}

async function approveBatch(agent: Agent, batchId: number, note = "Costs approved") {
  await decideAll(agent, batchId);
  return agent.post(`/api/batches/${batchId}/approve`).send({ note });
}

describe("POST /api/batches", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("requires a session", async () => {
    const response = await harness.request.post("/api/batches").send({ note: "hello" });
    expect(response.status).toBe(401);
  });

  it("requires a non-empty opening note", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    for (const note of [undefined, "", "   "]) {
      const response = await agent.post("/api/batches").send(note === undefined ? {} : { note });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("note");
    }
  });

  it("auto-assigns sequential human numbers and records the opening note as a timeline event", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    const first = await agent.post("/api/batches").send({ note: "first batch" });
    const second = await agent.post("/api/batches").send({ note: "second batch" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.number).toBe(1);
    expect(second.body.number).toBe(2);
    expect(first.body.deviceTotal).toBe(0);
    expect(first.body.deviceCounts).toEqual({
      awaitingRepair: 0,
      inProgress: 0,
      qa: 0,
      repaired: 0,
      unrepairable: 0,
      partsNeeded: 0,
      additionalIssuesPresent: 0,
      deniedRepair: 0,
    });

    const events = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE entity_type = 'batch' AND entity_id = ? ORDER BY id")
      .all(first.body.id) as { actor_id: number; action: string; payload: string }[];
    expect(events.map((e) => e.action)).toEqual(["batch.created", "note.added"]);
    expect(events[0].actor_id).toBe(first.body.createdBy.id);
    expect(JSON.parse(events[1].payload)).toEqual({ text: "first batch" });
  });
});

describe("GET /api/batches (derived device counts)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("derives per-status device counts from devices — never a stored, hand-edited status", async () => {
    const { agent, batch } = await createBatch(harness);

    const d1 = await addDevice(agent, batch.id, { imei: "111111111111111" });
    const d2 = await addDevice(agent, batch.id, { imei: "222222222222222" });
    const d3 = await addDevice(agent, batch.id, { imei: "333333333333333" });
    expect(d1.status).toBe(201);

    let list = await agent.get("/api/batches");
    expect(list.body[0].deviceCounts).toMatchObject({ awaitingRepair: 3 });
    expect(list.body[0].deviceTotal).toBe(3);

    // d1 runs the full happy path; d2 blocks on parts; d3 stays awaiting.
    // Approval comes first — it gates repair proceeding (ticket 06).
    await approveBatch(agent, batch.id);
    await setStatus(agent, batch.id, d1.body.id, "In progress");
    await setStatus(agent, batch.id, d1.body.id, "QA");
    await setStatus(agent, batch.id, d1.body.id, "Repaired", "Screen replaced; tested.");
    await setStatus(agent, batch.id, d2.body.id, "Parts needed");

    list = await agent.get("/api/batches");
    expect(list.body[0].deviceCounts).toEqual({
      awaitingRepair: 1,
      inProgress: 0,
      qa: 0,
      repaired: 1,
      unrepairable: 0,
      partsNeeded: 1,
      additionalIssuesPresent: 0,
      deniedRepair: 0,
    });
    expect(list.body[0].deviceTotal).toBe(3);

    // The newest batch is listed first.
    const newer = await agent.post("/api/batches").send({ note: "another one" });
    list = await agent.get("/api/batches");
    expect(list.body[0].number).toBe(newer.body.number);
  });

  it("returns batch detail with its devices", async () => {
    const { agent, batch } = await createBatch(harness);
    await addDevice(agent, batch.id, { imei: "111111111111111", capacity: "128gb" });

    const detail = await agent.get(`/api/batches/${batch.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(batch.id);
    expect(detail.body.devices).toHaveLength(1);
    expect(detail.body.devices[0].model.name).toBe("iPhone 13");
    expect(detail.body.devices[0].capacity).toBe("128gb");

    const missing = await agent.get("/api/batches/999");
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/batches (list serialization, ticket 01)", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("carries the lifecycle fields and the OPENING note — never a later note — on every row", async () => {
    const { agent, batch } = await createBatch(harness, "iPhone repair intake");
    const device = (await addDevice(agent, batch.id)).body as DeviceJson;

    const first = await agent.get("/api/batches");
    const awaiting = first.body[0] as BatchJson;
    expect(awaiting.status).toBe("Awaiting approval");
    expect(awaiting.openingNote).toBe("iPhone repair intake");
    expect(awaiting.approvedAt).toBeNull();
    expect(awaiting.approvedBy).toBeNull();
    expect(awaiting.approvedCostCents).toBeNull();
    expect(awaiting.closedAt).toBeNull();
    expect(awaiting.closedBy).toBeNull();

    // Approve, finish the device, add a LATER note, close: the opening note
    // stays the creation note, and the approval/close records ride the list
    // payload (the fields the old ad-hoc SELECT silently dropped).
    expect((await approveBatch(agent, batch.id)).status).toBe(200);
    expect((await setStatus(agent, batch.id, device.id, "In progress")).status).toBe(200);
    expect((await setStatus(agent, batch.id, device.id, "QA")).status).toBe(200);
    expect(
      (await setStatus(agent, batch.id, device.id, "Repaired", "Done.")).status
    ).toBe(200);
    await agent.post(`/api/batches/${batch.id}/notes`).send({ note: "a later note" });
    expect((await agent.post(`/api/batches/${batch.id}/close`)).status).toBe(200);

    const second = await agent.get("/api/batches");
    const closed = second.body[0] as BatchJson;
    expect(closed.status).toBe("Closed");
    expect(closed.openingNote).toBe("iPhone repair intake");
    expect(closed.approvedAt).not.toBeNull();
    expect(closed.approvedBy?.email).toBe(MANAGER);
    expect(closed.approvedCostCents).toBe(0);
    expect(closed.closedAt).not.toBeNull();
    expect(closed.closedBy?.email).toBe(MANAGER);
  });

  it("fails loud when a batch row has no opening-note event — no silent blank cells", async () => {
    // A batch row written behind createBatchRecord's back: no batch.created,
    // no note.added. The list must refuse to render it as a normal row.
    const { user, agent } = await harness.loginAs(MANAGER);
    harness.db
      .prepare("INSERT INTO batches (number, created_at, created_by) VALUES (?, ?, ?)")
      .run(1, harness.clock.now().toISOString(), user.id);

    const list = await agent.get("/api/batches");
    expect(list.status).toBe(500);
  });
});

describe("POST /api/batches/:id/devices", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("requires at least one identifier (IMEI, Asset ID, or serial number)", async () => {
    const { agent, batch } = await createBatch(harness);
    const response = await addDevice(agent, batch.id, { imei: "", assetId: "", serialNumber: "" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("at least one identifier");
  });

  it("accepts each identifier individually", async () => {
    const { agent, batch } = await createBatch(harness);
    const byAsset = await addDevice(agent, batch.id, { imei: "", assetId: "366801" });
    const bySerial = await addDevice(agent, batch.id, { imei: "", serialNumber: "SN-404" });

    expect(byAsset.status).toBe(201);
    expect(bySerial.status).toBe(201);
  });

  it("auto-sets Triage Date, defaults Assigned Tech to the creator, and starts in Awaiting repair", async () => {
    const { agent, batch } = await createBatch(harness);
    const response = await addDevice(agent, batch.id);

    expect(response.status).toBe(201);
    expect(response.body.triageDate).toBe(harness.clock.now().toISOString());
    expect(response.body.assignedTech.email).toBe(MANAGER);
    expect(response.body.repairStatus).toBe("Awaiting repair");
    expect(response.body.repairTimeMinutes).toBeNull();
  });

  it("lets the Assigned Tech be someone other than the creator", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const { agent, batch } = await createBatch(harness);
    const response = await addDevice(agent, batch.id, { assignedTechId: tech.user.id });

    expect(response.status).toBe(201);
    expect(response.body.assignedTech.email).toBe("tech@acme.co");
  });

  it("warns visibly — without blocking — when the IMEI already exists on another device", async () => {
    const { agent, batch } = await createBatch(harness);
    const first = await addDevice(agent, batch.id, { imei: "359175920074058" });
    const second = await addDevice(agent, batch.id, {
      imei: "359175920074058",
      assetId: "366801",
    });

    expect(first.status).toBe(201);
    expect(first.body.warnings).toEqual([]);
    expect(second.status).toBe(201); // not blocked
    expect(second.body.warnings).toHaveLength(1);
    expect(second.body.warnings[0]).toContain("359175920074058");
  });

  it("creates a model on the fly from the device form and records a model event", async () => {
    const { agent, batch } = await createBatch(harness);
    const response = await addDevice(agent, batch.id, {
      modelName: "iPad Pro 11\" M1",
      imei: "",
      serialNumber: "PAD-1",
    });

    expect(response.status).toBe(201);
    expect(response.body.model.name).toBe("iPad Pro 11\" M1");

    const event = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE action = 'model.created'")
      .get() as { actor_id: number; action: string; payload: string };
    expect(event.actor_id).toBe(batch.createdBy.id);
    expect(JSON.parse(event.payload)).toEqual({ name: "iPad Pro 11\" M1" });

    const reused = await addDevice(agent, batch.id, {
      modelName: "iPad Pro 11\" M1",
      imei: "",
      serialNumber: "PAD-2",
    });
    expect(reused.status).toBe(201);
    const count = harness.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE action = 'model.created'")
      .get() as { n: number };
    expect(count.n).toBe(1); // create-if-missing, not duplicates
  });

  it("records a device.created event with the actor stamped", async () => {
    const { agent, batch } = await createBatch(harness);
    const response = await addDevice(agent, batch.id, {
      repairTimeMinutes: 60,
      notes: "Grade C housing",
    });

    const event = harness.db
      .prepare("SELECT actor_id, at, action, payload FROM events WHERE action = 'device.created'")
      .get() as { actor_id: number; at: string; action: string; payload: string };
    expect(event.actor_id).toBe(batch.createdBy.id);
    expect(event.at).toBe(harness.clock.now().toISOString());
    expect(JSON.parse(event.payload)).toMatchObject({
      model: "iPhone 13",
      imei: "359175920074058",
      statedIssue: "Cracked screen",
    });
  });

  it("rejects an unknown assigned tech and a bad repair time", async () => {
    const { agent, batch } = await createBatch(harness);
    const badTech = await addDevice(agent, batch.id, { assignedTechId: 999 });
    expect(badTech.status).toBe(400);

    const badTime = await addDevice(agent, batch.id, { repairTimeMinutes: -5 });
    expect(badTime.status).toBe(400);
  });

  it("refuses to create a device in anything but Awaiting repair", async () => {
    const { agent, batch } = await createBatch(harness);
    const response = await addDevice(agent, batch.id, { repairStatus: "Repaired" });
    expect(response.status).toBe(400);
  });
});

describe("the Repair Status graph", () => {
  let harness: TestHarness;
  let agent: Agent;
  let batch: BatchJson;
  let device: DeviceJson;

  beforeEach(async () => {
    harness = createTestHarness();
    const created = await createBatch(harness);
    agent = created.agent;
    batch = created.batch;
    const response = await addDevice(agent, batch.id);
    device = response.body as DeviceJson;
    // Status transitions beyond blocking-on-parts require the manager's
    // approval first (ticket 06); the agent here IS the manager.
    expect((await approveBatch(agent, batch.id)).status).toBe(200);
  });

  afterEach(() => {
    harness.close();
  });

  it("walks Awaiting repair → In progress → QA → Repaired and records status events", async () => {
    const toProgress = await setStatus(agent, batch.id, device.id, "In progress");
    const toQa = await setStatus(agent, batch.id, device.id, "QA");
    const toRepaired = await setStatus(
      agent,
      batch.id,
      device.id,
      "Repaired",
      "Screen replaced; tested."
    );

    expect(toProgress.status).toBe(200);
    expect(toQa.status).toBe(200);
    expect(toRepaired.status).toBe(200);
    expect(toRepaired.body.repairStatus).toBe("Repaired");
    expect(toRepaired.body.resolutionNotes).toBe("Screen replaced; tested.");

    const events = harness.db
      .prepare("SELECT action, payload FROM events WHERE entity_type = 'device' AND entity_id = ? ORDER BY id")
      .all(device.id) as { action: string; payload: string }[];
    const statusEvents = events.filter((e) => e.action === "device.status_changed");
    expect(statusEvents).toHaveLength(3);
    expect(JSON.parse(statusEvents[0].payload)).toEqual({ from: "Awaiting repair", to: "In progress" });
    expect(JSON.parse(statusEvents[2].payload)).toEqual({
      from: "QA",
      to: "Repaired",
      resolutionNotes: "Screen replaced; tested.",
    });
  });

  it("reaches a terminal status without resolution notes — the status change is the record", async () => {
    await setStatus(agent, batch.id, device.id, "In progress");

    // A given-but-blank note is refused loudly, never silently dropped.
    const blank = await setStatus(agent, batch.id, device.id, "Repaired", "   ");
    expect(blank.status).toBe(400);

    // Omitted notes are accepted: the status change itself is the record,
    // and the device keeps whatever resolution notes it already had.
    const ok = await setStatus(agent, batch.id, device.id, "Repaired");
    expect(ok.status).toBe(200);
    expect(ok.body.resolutionNotes).toBeNull();

    // Terminal statuses are not traps — back to work, then terminal again.
    await setStatus(agent, batch.id, device.id, "In progress");
    const again = await setStatus(agent, batch.id, device.id, "Unrepairable");
    expect(again.status).toBe(200);
    expect(again.body.resolutionNotes).toBeNull();
  });

  it("forbids skipping into terminal statuses from Awaiting repair", async () => {
    for (const terminal of ["Repaired", "Unrepairable", "Additional issues present"]) {
      const response = await setStatus(agent, batch.id, device.id, terminal, "nope");
      expect(response.status).toBe(409);
    }
  });

  it("a terminal status can be LEFT — the accident correction is a graph edge like any other", async () => {
    await setStatus(agent, batch.id, device.id, "In progress");
    await setStatus(agent, batch.id, device.id, "Repaired", "Done.");

    // The exits are offered to the client via the server-owned list.
    const detail = await agent.get(`/api/batches/${batch.id}`);
    const row = (detail.body as { devices: DeviceJson[] }).devices.find(
      (d) => d.id === device.id,
    )!;
    expect(row.allowedNextStatuses).toEqual(["Awaiting repair", "In progress", "QA"]);

    // The correction works: Repaired → QA.
    const response = await setStatus(agent, batch.id, device.id, "QA");
    expect(response.status).toBe(200);
    expect(response.body.repairStatus).toBe("QA");

    // Non-exit targets still refuse — the graph, not the terminal word, decides.
    await setStatus(agent, batch.id, device.id, "Repaired", "Done again.");
    const refused = await setStatus(agent, batch.id, device.id, "Unrepairable", "try again");
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("cannot move from Repaired to Unrepairable");

    // The correction is evented from → to.
    const events = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.status_changed' ORDER BY id"
      )
      .all(device.id) as Array<{ payload: string }>;
    expect(
      events.map((row) => JSON.parse(row.payload)).filter(
        (payload) => payload.from === "Repaired" && payload.to === "QA",
      ),
    ).toEqual([{ from: "Repaired", to: "QA" }]);
  });

  it("a tech can put a phone down: In progress and Repaired both return to Awaiting repair", async () => {
    // Stock to prove the put-down leaves attachments untouched.
    const skuResponse = await agent
      .post("/api/skus")
      .send({ name: "iPhone 13 Screen", price: "109.99", kind: "serialized" });
    const sku = skuResponse.body as { id: number };
    await agent.post(`/api/skus/${sku.id}/parts`).send({ source: "migration", quantity: 1, counted: false });
    expect(
      (await agent.post(`/api/batches/${batch.id}/devices/${device.id}/parts`).send({ skuId: sku.id, note: "screen for the put-down test" })).status
    ).toBe(201);

    // Picked up, then put down — the parts stay attached and Reserved; only
    // the work state rewinds.
    expect((await setStatus(agent, batch.id, device.id, "In progress")).status).toBe(200);
    expect((await setStatus(agent, batch.id, device.id, "Awaiting repair")).status).toBe(200);
    expect((await setStatus(agent, batch.id, device.id, "In progress")).status).toBe(200);
    expect(
      (await setStatus(agent, batch.id, device.id, "Repaired", "Done.")).status
    ).toBe(200);
    // Repaired → Awaiting repair: the accidental-set correction.
    const response = await setStatus(agent, batch.id, device.id, "Awaiting repair");
    expect(response.status).toBe(200);
    expect(response.body.repairStatus).toBe("Awaiting repair");

    const parts = await agent.get(`/api/batches/${batch.id}/parts`);
    const deviceParts = (parts.body as {
      devices: Array<{ deviceId: number; parts: Array<{ part: { status: string }; removedAt: string | null }> }>;
    }).devices.find((d) => d.deviceId === device.id)!.parts;
    const attached = deviceParts.filter((p) => p.removedAt === null);
    expect(attached).toHaveLength(1);
    expect(attached[0].part.status).toBe("reserved");
  });

  it("every terminal status has an exit back to real work", async () => {
    // Unrepairable → In progress.
    await setStatus(agent, batch.id, device.id, "In progress");
    await setStatus(agent, batch.id, device.id, "Unrepairable", "Board dead.");
    expect((await setStatus(agent, batch.id, device.id, "In progress")).status).toBe(200);

    // Additional issues present → In progress: the exit does NOT undo the
    // retriage — the continuation row (with its moved parts) still exists on
    // the new batch; the accidental continuation is removed separately
    // through the device-removal flow.
    const skuResponse = await agent
      .post("/api/skus")
      .send({ name: "iPhone 13 Screen", price: "109.99", kind: "serialized" });
    const sku = skuResponse.body as { id: number };
    const intake = await agent.post(`/api/skus/${sku.id}/parts`).send({
      source: "migration",
      quantity: 1,
      counted: false,
    });
    const serial = (intake.body.parts as Array<{ serial: string }>)[0].serial;
    expect((await agent.post(`/api/batches/${batch.id}/devices/${device.id}/parts`).send({ skuId: sku.id, note: "adding a screen for the retriage test" })).status).toBe(201);
    await setStatus(agent, batch.id, device.id, "Additional issues present", "More problems found.");
    expect((await setStatus(agent, batch.id, device.id, "In progress")).status).toBe(200);

    const continuation = harness.db
      .prepare("SELECT id, batch_id FROM devices WHERE prior_device_id = ?")
      .get(device.id) as { id: number; batch_id: number };
    expect(continuation.batch_id).not.toBe(batch.id);
    // The moved part is Reserved on the CONTINUATION row — the exit changed
    // nothing about the retriage.
    const partRow = harness.db
      .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
      .get(serial) as { status: string };
    expect(partRow.status).toBe("reserved");
    const attachment = harness.db
      .prepare(
        "SELECT device_id, removed_at IS NULL AS active FROM device_parts WHERE part_id = (SELECT id FROM serialized_parts WHERE serial = ?) ORDER BY id DESC LIMIT 1"
      )
      .get(serial) as { device_id: number; active: number };
    expect(attachment.device_id).toBe(continuation.id);
    expect(attachment.active).toBe(1);
  });

  it("leaving Denied Repair returns the device to Awaiting repair — the denial's part return is not undone", async () => {
    // Denied Repair is set ONLY by the manager's rejection at batch
    // approval, so this needs its own (not-yet-approved) batch: two devices,
    // one rejected.
    const created = await agent.post("/api/batches").send({ note: "denial correction" });
    const denialBatch = created.body as BatchJson;
    const kept = (await addDevice(agent, denialBatch.id, { imei: "333333333333333" })).body as DeviceJson;
    const denied = (await addDevice(agent, denialBatch.id, { imei: "444444444444444" })).body as DeviceJson;
    const skuResponse = await agent
      .post("/api/skus")
      .send({ name: "iPhone 13 Screen", price: "109.99", kind: "serialized" });
    const sku = skuResponse.body as { id: number };
    const intake = await agent.post(`/api/skus/${sku.id}/parts`).send({
      source: "migration",
      quantity: 2,
      counted: false,
    });
    const serials = (intake.body.parts as Array<{ serial: string }>).map((part) => part.serial);
    expect((await agent.post(`/api/batches/${denialBatch.id}/devices/${kept.id}/parts`).send({ skuId: sku.id })).status).toBe(201);
    expect((await agent.post(`/api/batches/${denialBatch.id}/devices/${denied.id}/parts`).send({ skuId: sku.id })).status).toBe(201);

    await agent.post(`/api/batches/${denialBatch.id}/devices/${denied.id}/approval`).send({
      decision: "rejected",
      note: "rejected in the wrong tab — an accident",
    });
    await agent.post(`/api/batches/${denialBatch.id}/devices/${kept.id}/approval`).send({ decision: "approved" });
    // NOT the decideAll-wrapping helper — it would flip the rejection.
    expect((await agent.post(`/api/batches/${denialBatch.id}/approve`).send({ note: "Costs approved" })).status).toBe(200);

    // At the denial, the device's part went back to stock.
    expect(
      (harness.db.prepare("SELECT status FROM serialized_parts WHERE serial = ?").get(serials[1]) as { status: string }).status
    ).toBe("available");

    // The correction: Denied Repair → Awaiting repair. The part does NOT
    // re-reserve itself — it is re-added through the normal part flow.
    const response = await setStatus(agent, denialBatch.id, denied.id, "Awaiting repair");
    expect(response.status).toBe(200);
    expect(response.body.repairStatus).toBe("Awaiting repair");
    expect(
      (harness.db.prepare("SELECT status FROM serialized_parts WHERE serial = ?").get(serials[1]) as { status: string }).status
    ).toBe("available");
    // The kept device is untouched by the correction.
    expect(
      (harness.db.prepare("SELECT status FROM serialized_parts WHERE serial = ?").get(serials[0]) as { status: string }).status
    ).toBe("reserved");
  });

  it("exposes Parts needed and unblocks back into In progress", async () => {
    const blocked = await setStatus(agent, batch.id, device.id, "Parts needed");
    expect(blocked.status).toBe(200);
    expect(blocked.body.repairStatus).toBe("Parts needed");

    const unblocked = await setStatus(agent, batch.id, device.id, "In progress");
    expect(unblocked.status).toBe(200);

    // QA devices can also block on parts.
    await setStatus(agent, batch.id, device.id, "QA");
    const fromQa = await setStatus(agent, batch.id, device.id, "Parts needed");
    expect(fromQa.status).toBe(200);
  });

  it("rejects unknown statuses and unknown devices", async () => {
    const unknown = await setStatus(agent, batch.id, device.id, "Shipped");
    expect(unknown.status).toBe(400);

    const missing = await setStatus(agent, batch.id, 999, "In progress");
    expect(missing.status).toBe(404);

    const wrongBatch = await agent.post(`/api/batches/999/devices/${device.id}/status`).send({
      repairStatus: "In progress",
    });
    expect(wrongBatch.status).toBe(404);
  });

  it("does not record an event when the status is unchanged", async () => {
    const noop = await setStatus(agent, batch.id, device.id, "Awaiting repair");
    expect(noop.status).toBe(200);
    const count = harness.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE action = 'device.status_changed'")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("PATCH /api/batches/:id/devices/:deviceId", () => {
  let harness: TestHarness;
  let agent: Agent;
  let batch: BatchJson;
  let device: DeviceJson;

  beforeEach(async () => {
    harness = createTestHarness();
    const created = await createBatch(harness);
    agent = created.agent;
    batch = created.batch;
    const response = await addDevice(agent, batch.id);
    device = response.body as DeviceJson;
  });

  afterEach(() => {
    harness.close();
  });

  it("edits fields and records a device.edited event with old→new values", async () => {
    const response = await agent.patch(`/api/batches/${batch.id}/devices/${device.id}`).send({
      capacity: "128gb",
      repairTimeMinutes: 60,
      notes: "Grade C housing",
    });

    expect(response.status).toBe(200);
    expect(response.body.capacity).toBe("128gb");
    expect(response.body.repairTimeMinutes).toBe(60);
    expect(response.body.repairStatus).toBe("Awaiting repair");

    const event = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE action = 'device.edited'")
      .get() as { actor_id: number; action: string; payload: string };
    expect(event.actor_id).toBe(batch.createdBy.id);
    expect(JSON.parse(event.payload)).toEqual({
      fields: {
        capacity: { from: null, to: "128gb" },
        repairTimeMinutes: { from: null, to: 60 },
        notes: { from: null, to: "Grade C housing" },
      },
    });
  });

  it("routes status changes through the status endpoint only", async () => {
    const response = await agent
      .patch(`/api/batches/${batch.id}/devices/${device.id}`)
      .send({ repairStatus: "In progress" });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("status");
  });

  it("still enforces the identifier rule and warns on duplicate IMEIs when editing", async () => {
    const other = await addDevice(agent, batch.id, { imei: "222222222222222" });

    const stripped = await agent
      .patch(`/api/batches/${batch.id}/devices/${device.id}`)
      .send({ imei: "", assetId: "", serialNumber: "" });
    expect(stripped.status).toBe(400);

    const dup = await agent
      .patch(`/api/batches/${batch.id}/devices/${other.body.id}`)
      .send({ imei: "359175920074058" });
    expect(dup.status).toBe(200);
    expect(dup.body.warnings).toHaveLength(1);
    expect(dup.body.warnings[0]).toContain("359175920074058");
  });
});

describe("the batch timeline", () => {
  let harness: TestHarness;
  let agent: Agent;
  let batch: BatchJson;

  beforeEach(async () => {
    harness = createTestHarness();
    const created = await createBatch(harness);
    agent = created.agent;
    batch = created.batch;
  });

  afterEach(() => {
    harness.close();
  });

  it("merges typed notes and system events chronologically, per batch", async () => {
    const added = await agent.post(`/api/batches/${batch.id}/notes`).send({ note: "Pulled from intake shelf." });
    expect(added.status).toBe(201);
    expect(added.body.action).toBe("note.added");
    expect(added.body.payload).toEqual({ text: "Pulled from intake shelf." });

    const device = await addDevice(agent, batch.id);
    await approveBatch(agent, batch.id);
    await setStatus(agent, batch.id, device.body.id, "In progress");

    const timeline = await agent.get(`/api/batches/${batch.id}/timeline`);
    expect(timeline.status).toBe(200);
    const entries = timeline.body as EventJson[];

    // batch.created, note.added (opening), note.added, device.created,
    // device.approval_decided (ticket 25: the per-device decision),
    // batch.approved (ticket 06), device.status_changed — chronological by id.
    expect(entries.map((e) => e.action)).toEqual([
      "batch.created",
      "note.added",
      "note.added",
      "device.created",
      "device.approval_decided",
      "batch.approved",
      "device.status_changed",
    ]);
    expect(entries.map((e) => e.id)).toEqual([...entries.map((e) => e.id)].sort((a, b) => a - b));
    expect(entries[1].actor?.email).toBe(MANAGER);
    expect(entries[3].entityType).toBe("device");
    expect(entries[3].payload).toMatchObject({ model: "iPhone 13" });
  });

  it("requires non-empty note text", async () => {
    const response = await agent.post(`/api/batches/${batch.id}/notes`).send({ note: "  " });
    expect(response.status).toBe(400);
  });

  it("has no edit or delete endpoints for timeline entries", async () => {
    const timeline = await agent.get(`/api/batches/${batch.id}/timeline`);
    const entryId = (timeline.body as EventJson[])[0].id;

    const patch = await agent
      .patch(`/api/batches/${batch.id}/timeline/${entryId}`)
      .send({ text: "rewritten" });
    expect(patch.status).toBe(404);

    const deleted = await agent.delete(`/api/batches/${batch.id}/timeline/${entryId}`);
    expect(deleted.status).toBe(404);

    const stillThere = await agent.get(`/api/batches/${batch.id}/timeline`);
    expect((stillThere.body as EventJson[])).toHaveLength(2);
  });
});

describe("the device model list", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.close();
  });

  it("lists models and records an event when a tech extends the list", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    const created = await agent.post("/api/models").send({ name: "iPhone 15 Pro Max" });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe("iPhone 15 Pro Max");

    const duplicate = await agent.post("/api/models").send({ name: "iPhone 15 Pro Max" });
    expect(duplicate.status).toBe(409);

    const list = await agent.get("/api/models");
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe("iPhone 15 Pro Max");

    const event = harness.db
      .prepare("SELECT action, payload FROM events WHERE action = 'model.created'")
      .get() as { action: string; payload: string };
    expect(JSON.parse(event.payload)).toEqual({ name: "iPhone 15 Pro Max" });
  });

  it("treats model names case-insensitively, like serials and SKUs", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    const created = await agent.post("/api/models").send({ name: "iPhone 15 Pro Max" });
    expect(created.status).toBe(201);

    const differentCase = await agent.post("/api/models").send({ name: "IPHONE 15 PRO MAX" });
    expect(differentCase.status).toBe(409);
    expect(String(differentCase.body.error)).toContain("already exists");

    const list = await agent.get("/api/models");
    expect(list.body).toHaveLength(1);
  });

  it("lists models alphabetically regardless of letter case (portable LOWER ordering)", async () => {
    const { agent } = await harness.loginAs(MANAGER);
    await agent.post("/api/models").send({ name: "zebra Phone" });
    await agent.post("/api/models").send({ name: "AirTag" });
    await agent.post("/api/models").send({ name: "mac mini" });

    const list = await agent.get("/api/models");
    expect(list.body.map((model: { name: string }) => model.name)).toEqual([
      "AirTag",
      "mac mini",
      "zebra Phone",
    ]);
  });
});
