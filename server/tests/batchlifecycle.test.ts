import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";
import { movePartFromReserved } from "../domains/parts/status.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

/**
 * Ticket 06: the batch lifecycle — approval (cost sign-off), close (with the
 * terminal guard and part settlement), and retriage ("Additional issues
 * present" carries the device's parts onto a new batch). Everything drives
 * the HTTP API seam with a throwaway SQLite file, per the project's
 * single-test-seam decision.
 */

const SCREEN = { name: "iPhone 13 Screen", price: "109.99", kind: "serialized" };
const BATTERY = { name: "iPhone 13 Battery", price: "45.00", kind: "serialized" };
const ADHESIVE = { name: "Adhesive strips", price: "1.50", kind: "consumable" };

interface SkuJson {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
}

interface BatchJson {
  id: number;
  number: number;
  status: string;
  approvedCostCents: number | null;
  approvedCost: string | null;
  approvedBy: { id: number; email: string } | null;
  closedAt: string | null;
  partEditPermissions?: {
    addPart: boolean;
    removePart: boolean;
    consumable: boolean;
    swapPart: boolean;
  };
}

interface DeviceJson {
  id: number;
  batchId: number;
  imei: string | null;
  repairStatus: string;
  allowedNextStatuses: string[];
  priorDeviceId: number | null;
  warnings?: string[];
}

async function createSku(agent: Agent, overrides: Record<string, unknown> = {}): Promise<SkuJson> {
  const response = await agent.post("/api/skus").send({ ...SCREEN, ...overrides });
  expect(response.status).toBe(201);
  return response.body as SkuJson;
}

async function intakeParts(agent: Agent, skuId: number, count: number): Promise<string[]> {
  const response = await agent.post(`/api/skus/${skuId}/parts`).send({ source: "migration", quantity: count, counted: false });
  expect(response.status).toBe(201);
  return (response.body.parts as Array<{ serial: string }>).map((part) => part.serial);
}

async function createBatch(agent: Agent, note = "Batch opened for triage") {
  const response = await agent.post("/api/batches").send({ note });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number; status: string };
}

async function addDevice(
  agent: Agent,
  batchId: number,
  overrides: Record<string, unknown> = {}
) {
  const response = await agent
    .post(`/api/batches/${batchId}/devices`)
    .send({ modelName: "iPhone 13", statedIssue: "Cracked screen", imei: "111111111111111", ...overrides });
  expect(response.status).toBe(201);
  return response.body as DeviceJson;
}

async function addPart(
  agent: Agent,
  batchId: number,
  deviceId: number,
  body: Record<string, unknown>
) {
  return agent.post(`/api/batches/${batchId}/devices/${deviceId}/parts`).send(body);
}

async function setStatus(
  agent: Agent,
  batchId: number,
  deviceId: number,
  repairStatus: string,
  resolutionNotes?: string
) {
  return agent
    .post(`/api/batches/${batchId}/devices/${deviceId}/status`)
    .send(resolutionNotes === undefined ? { repairStatus } : { repairStatus, resolutionNotes });
}

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

async function approveBatch(agent: Agent, batchId: number, note = "Costs look right") {
  await decideAll(agent, batchId);
  return agent.post(`/api/batches/${batchId}/approve`).send({ note });
}

async function closeBatch(agent: Agent, batchId: number) {
  return agent.post(`/api/batches/${batchId}/close`).send({});
}

function partStatus(harness: TestHarness, serial: string): string {
  const row = harness.db
    .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
    .get(serial) as { status: string };
  return row?.status;
}

interface Setup {
  harness: TestHarness;
  tech: LoggedInAgent;
  manager: LoggedInAgent;
}

/** Tech-owned batch with one device and one reserved part; not yet approved. */
async function setupBatchWithPart(): Promise<Setup & {
  batch: { id: number; number: number };
  device: DeviceJson;
  serials: string[];
  sku: SkuJson;
}> {
  const harness = createTestHarness();
  const tech = await harness.createUserAs("tech@acme.co", "tech");
  const manager = await harness.loginAs(MANAGER);
  const sku = await createSku(tech.agent);
  const serials = await intakeParts(tech.agent, sku.id, 2);
  const batch = await createBatch(tech.agent);
  const device = await addDevice(tech.agent, batch.id);
  const added = await addPart(tech.agent, batch.id, device.id, { skuId: sku.id });
  expect(added.status).toBe(201);
  return { harness, tech, manager, batch, device, serials, sku };
}

describe("batch lifecycle: approval", () => {
  let harness: TestHarness;
  afterEach(() => harness?.close());

  it("a new batch starts in Awaiting approval with no approved cost", async () => {
    harness = createTestHarness();
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const batch = await createBatch(tech.agent);
    expect(batch.status).toBe("Awaiting approval");

    const detail = (await tech.agent.get(`/api/batches/${batch.id}`)).body as BatchJson;
    expect(detail.status).toBe("Awaiting approval");
    expect(detail.approvedCostCents).toBeNull();
    expect(detail.approvedBy).toBeNull();
    // Pre-approval, techs edit part lists freely.
    expect(detail.partEditPermissions).toEqual({
      addPart: true,
      removePart: true,
      consumable: true,
      swapPart: true,
    });
  });

  it("techs cannot approve; a manager's approval opens the batch and records the approved total", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    const adhesive = await createSku(setup.tech.agent, ADHESIVE);
    // A second part + consumable usage so the approved total is non-trivial:
    // 109.99 (reserved) + 2 × 1.50 (consumable) = 112.99.
    await addPart(setup.tech.agent, setup.batch.id, setup.device.id, { skuId: adhesive.id });
    const usage = await setup.tech.agent
      .post(`/api/batches/${setup.batch.id}/devices/${setup.device.id}/consumables`)
      .send({ skuId: adhesive.id, quantity: 2 });
    expect(usage.status).toBe(201);

    const forbidden = await approveBatch(setup.tech.agent, setup.batch.id);
    expect(forbidden.status).toBe(403);

    const noNote = await approveBatch(setup.manager.agent, setup.batch.id, "  ");
    expect(noNote.status).toBe(400);

    const approved = await approveBatch(setup.manager.agent, setup.batch.id);
    expect(approved.status).toBe(200);
    const body = approved.body as BatchJson;
    expect(body.status).toBe("Open");
    expect(body.approvedCostCents).toBe(11299);
    expect(body.approvedCost).toBe("112.99");
    expect(body.approvedBy?.email).toBe(MANAGER);

    // The approval is a cost sign-off recorded on the timeline.
    const event = harness.db
      .prepare("SELECT actor_id, action, payload FROM events WHERE action = 'batch.approved'")
      .get() as { actor_id: number; payload: string };
    expect(event.actor_id).toBe(setup.manager.user.id);
    expect(JSON.parse(event.payload)).toMatchObject({ totalCents: 11299, note: "Costs look right" });
    const row = harness.db
      .prepare("SELECT status, approved_cost_cents FROM batches WHERE id = ?")
      .get(setup.batch.id) as { status: string; approved_cost_cents: number };
    expect(row.status).toBe("Open");
    expect(row.approved_cost_cents).toBe(11299);
  });

  it("approves WITHOUT a note — the sign-off is the record", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    await decideAll(setup.manager.agent, setup.batch.id);
    const approved = await setup.manager.agent
      .post(`/api/batches/${setup.batch.id}/approve`)
      .send({});
    expect(approved.status).toBe(200);

    const event = harness.db
      .prepare("SELECT payload FROM events WHERE action = 'batch.approved'")
      .get() as { payload: string };
    // A noteless approval records NO note at all — the payload simply lacks
    // the key (JSON.stringify drops undefined), the same payload shape the
    // noteless PO approval uses.
    expect(JSON.parse(event.payload)).toEqual({
      totalCents: 10999,
      total: "109.99",
      deniedDevices: [],
    });
  });

  it("approving twice is refused", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);
    const again = await approveBatch(setup.manager.agent, setup.batch.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("Awaiting approval");
  });

  it("approval gates repair proceeding: a device cannot leave Awaiting repair before sign-off", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;

    const blocked = await setStatus(setup.tech.agent, setup.batch.id, setup.device.id, "In progress");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("Awaiting approval");

    // Blocking on parts is not repair work — stock reservation is free pre-approval.
    const partsNeeded = await setStatus(
      setup.tech.agent,
      setup.batch.id,
      setup.device.id,
      "Parts needed"
    );
    expect(partsNeeded.status).toBe(200);

    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);
    const proceeds = await setStatus(setup.tech.agent, setup.batch.id, setup.device.id, "In progress");
    expect(proceeds.status).toBe(200);
  });
});

describe("post-approval part-edit restrictions", () => {
  let harness: TestHarness;
  afterEach(() => harness?.close());

  it("techs may swap same-SKU after approval; with the default limit 0, add and consumables are refused by the price gate; removal is a tech decision (ticket 02)", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);

    const otherSku = await createSku(setup.tech.agent, BATTERY);
    await intakeParts(setup.tech.agent, otherSku.id, 1);

    // Ticket 28: the default limit is 0 — no post-approval headroom, so the
    // price gate refuses the add (naming the options) where ticket 06
    // refused it outright.
    const add = await addPart(setup.tech.agent, setup.batch.id, setup.device.id, {
      skuId: otherSku.id,
    });
    expect(add.status).toBe(409);
    expect(add.body.error).toContain("price add limit");
    expect(add.body.error).toContain("a manager can add it in place");

    const attachmentId = (
      harness.db
        .prepare("SELECT id FROM device_parts WHERE device_id = ? AND removed_at IS NULL")
        .get(setup.device.id) as { id: number }
    ).id;

    const adhesive = await createSku(setup.tech.agent, ADHESIVE);
    const consumable = await setup.tech.agent
      .post(`/api/batches/${setup.batch.id}/devices/${setup.device.id}/consumables`)
      .send({ skuId: adhesive.id, quantity: 1 });
    expect(consumable.status).toBe(409);
    expect(consumable.body.error).toContain("price add limit");

    // Same-SKU swaps never wait for approval (CONTEXT.md).
    const swap = await setup.tech.agent.post(
      `/api/batches/${setup.batch.id}/devices/${setup.device.id}/parts/${attachmentId}/swap`
    ).send({ destination: "available", note: "first unit was DOA" });
    expect(swap.status).toBe(201);

    // Ticket 02: the swap-in replacement is removable by the tech too —
    // a removal only ever reduces cost, so it is never manager-gated, and
    // it amends the approval in place with its note.
    const swappedId = (swap.body as { attachment: { id: number } }).attachment.id as number;
    const remove = await setup.tech.agent.post(
      `/api/batches/${setup.batch.id}/devices/${setup.device.id}/parts/${swappedId}/remove`
    ).send({ destination: "available", note: "part was never needed" });
    expect(remove.status).toBe(200);
    expect((remove.body as { attachment: { removedTo: string } }).attachment.removedTo).toBe(
      "available"
    );
    const batchRow = harness.db
      .prepare("SELECT approved_cost_cents FROM batches WHERE id = ?")
      .get(setup.batch.id) as { approved_cost_cents: number };
    expect(batchRow.approved_cost_cents).toBe(0);
  });

  it("a manager changes parts in place with a note and the approval stands amended", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);
    const before = 10999;

    const battery = await createSku(setup.tech.agent, BATTERY);
    // Two units: one for the noteless add, one for the noted add (a second
    // add against one unit would file a Need to Order instead of reserving).
    await intakeParts(setup.tech.agent, battery.id, 2);

    // The note (optional) is what records why; here it is given. A noteless
    // add is also accepted — the amendment event itself records the move.
    const noNote = await addPart(setup.manager.agent, setup.batch.id, setup.device.id, {
      skuId: battery.id,
    });
    expect(noNote.status).toBe(201);

    const added = await addPart(setup.manager.agent, setup.batch.id, setup.device.id, {
      skuId: battery.id,
      note: "customer also wants the battery replaced",
    });
    expect(added.status).toBe(201);

    // The signed-off total moved with the changes, and the amendments are on
    // the timeline.
    const detail = (await setup.manager.agent.get(`/api/batches/${setup.batch.id}`)).body as BatchJson;
    expect(detail.approvedCostCents).toBe(before + 2 * 4500);

    const amended = harness.db
      .prepare("SELECT payload FROM events WHERE action = 'batch.approval_amended' ORDER BY id DESC")
      .get() as { payload: string };
    expect(JSON.parse(amended.payload)).toMatchObject({
      // The LATEST amendment: the noted battery add (the noteless one before
      // it moved 10999 → 11499 first).
      previousTotalCents: before + 4500,
      totalCents: before + 2 * 4500,
      note: "customer also wants the battery replaced",
    });

    // Removing (with a note) amends again.
    const attachmentId = (
      harness.db
        .prepare(
          "SELECT id FROM device_parts WHERE device_id = ? AND removed_at IS NULL ORDER BY id DESC"
        )
        .get(setup.device.id) as { id: number }
    ).id;
    const removed = await setup.manager.agent.post(
      `/api/batches/${setup.batch.id}/devices/${setup.device.id}/parts/${attachmentId}/remove`
    ).send({ destination: "available", note: "battery not needed after all" });
    expect(removed.status).toBe(200);
    const after = (await setup.manager.agent.get(`/api/batches/${setup.batch.id}`)).body as BatchJson;
    // One of the two batteries left: 10999 + 4500 remains.
    expect(after.approvedCostCents).toBe(before + 4500);
  });

  it("post-approval consumable usage by a manager amends the approval — note optional", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    const adhesive = await createSku(setup.tech.agent, ADHESIVE);
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);

    // Noteless usage is accepted — the usage event itself records the cost
    // movement (the optional-note contract, same as the approval's).
    const noNote = await setup.manager.agent
      .post(`/api/batches/${setup.batch.id}/devices/${setup.device.id}/consumables`)
      .send({ skuId: adhesive.id, quantity: 3 });
    expect(noNote.status).toBe(201);
    const detail = (await setup.manager.agent.get(`/api/batches/${setup.batch.id}`)).body as BatchJson;
    expect(detail.approvedCostCents).toBe(10999 + 3 * 150);

    const withNote = await setup.manager.agent
      .post(`/api/batches/${setup.batch.id}/devices/${setup.device.id}/consumables`)
      .send({ skuId: adhesive.id, quantity: 1, note: "one more strip" });
    expect(withNote.status).toBe(201);
  });
});

describe("close", () => {
  let harness: TestHarness;
  afterEach(() => harness?.close());

  it("close is blocked while any device is non-terminal, before approval, and on an empty batch", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;

    // Lifecycle order: Awaiting approval → Open → Closed.
    const unapproved = await closeBatch(setup.tech.agent, setup.batch.id);
    expect(unapproved.status).toBe(409);
    expect(unapproved.body.error).toContain("Awaiting approval");

    await approveBatch(setup.manager.agent, setup.batch.id);
    const working = await closeBatch(setup.tech.agent, setup.batch.id);
    expect(working.status).toBe(409);
    expect(working.body.error).toContain("Awaiting repair");

    // An empty batch has no terminal devices — close means done.
    const empty = await createBatch(setup.tech.agent, "empty batch");
    await approveBatch(setup.manager.agent, empty.id);
    const emptyClose = await closeBatch(setup.tech.agent, empty.id);
    expect(emptyClose.status).toBe(409);
    expect(emptyClose.body.error).toContain("no devices");
  });

  it("any user may close an all-terminal batch; installed parts become Unavailable via events", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    await approveBatch(setup.manager.agent, setup.batch.id);
    expect(
      (await setStatus(setup.tech.agent, setup.batch.id, setup.device.id, "In progress")).status
    ).toBe(200);
    expect(
      (
        await setStatus(
          setup.tech.agent,
          setup.batch.id,
          setup.device.id,
          "Repaired",
          "Screen replaced and tested."
        )
      ).status
    ).toBe(200);

    const closed = await closeBatch(setup.tech.agent, setup.batch.id);
    expect(closed.status).toBe(200);
    const body = closed.body as BatchJson;
    expect(body.status).toBe("Closed");
    expect(body.closedAt).not.toBeNull();

    // The installed unit is consumed by the repair — out of circulation.
    expect(partStatus(harness, setup.serials[0])).toBe("unavailable");
    // The spare unit was never attached — still Available for the next batch.
    expect(partStatus(harness, setup.serials[1])).toBe("available");

    const partEvent = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'part' AND action = 'part.status_changed'"
      )
      .get() as { payload: string };
    // Ticket 03: the settlement's event reason names WHY the part moved —
    // this device is Repaired and its SCREEN SKU is not buybackable, so the
    // part was consumed by the repair.
    expect(JSON.parse(partEvent.payload)).toMatchObject({
      serial: setup.serials[0],
      from: "reserved",
      to: "unavailable",
      reason: "batch_closed_repaired_unavailable",
    });

    const batchEvent = harness.db
      .prepare("SELECT payload FROM events WHERE action = 'batch.closed'")
      .get() as { payload: string };
    expect(JSON.parse(batchEvent.payload)).toMatchObject({
      settled: [{ serial: setup.serials[0] }],
    });

    const again = await closeBatch(setup.tech.agent, setup.batch.id);
    expect(again.status).toBe(409);
  });

  it("a device corrected out of Repaired blocks close again until the repair is re-recorded", async () => {
    // Terminal is not absorbing (accident correction), but it IS still
    // terminal for close: leaving Repaired makes the device non-terminal,
    // and the batch cannot close until it reaches a terminal status once more.
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    await approveBatch(setup.manager.agent, setup.batch.id);
    await setStatus(setup.tech.agent, setup.batch.id, setup.device.id, "In progress");
    expect(
      (
        await setStatus(
          setup.tech.agent,
          setup.batch.id,
          setup.device.id,
          "Repaired",
          "Screen replaced."
        )
      ).status
    ).toBe(200);

    // The correction: Repaired → QA. Close is refused while it lasts.
    expect(
      (await setStatus(setup.tech.agent, setup.batch.id, setup.device.id, "QA")).status
    ).toBe(200);
    const blocked = await closeBatch(setup.tech.agent, setup.batch.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("not yet terminal");

    // Re-record the repair: close goes through, and the parts settle exactly
    // as they would have without the detour.
    expect(
      (
        await setStatus(
          setup.tech.agent,
          setup.batch.id,
          setup.device.id,
          "Repaired",
          "Screen replaced (re-recorded after correction)."
        )
      ).status
    ).toBe(200);
    const closed = await closeBatch(setup.tech.agent, setup.batch.id);
    expect(closed.status).toBe(200);
    expect((closed.body as BatchJson).status).toBe("Closed");
    expect(partStatus(harness, setup.serials[0])).toBe("unavailable");
  });

  it("a part removed to Available before close stays Available", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    const attachmentId = (
      harness.db
        .prepare("SELECT id FROM device_parts WHERE device_id = ? AND removed_at IS NULL")
        .get(setup.device.id) as { id: number }
    ).id;
    // Pre-approval the tech edits the part list freely.
    const removed = await setup.tech.agent.post(
      `/api/batches/${setup.batch.id}/devices/${setup.device.id}/parts/${attachmentId}/remove`
    ).send({ destination: "available", note: "wrong part picked" });
    expect(removed.status).toBe(200);

    await approveBatch(setup.manager.agent, setup.batch.id);
    expect(
      (await setStatus(setup.tech.agent, setup.batch.id, setup.device.id, "In progress")).status
    ).toBe(200);
    expect(
      (
        await setStatus(
          setup.tech.agent,
          setup.batch.id,
          setup.device.id,
          "Unrepairable",
          "Board is beyond repair."
        )
      ).status
    ).toBe(200);
    expect((await closeBatch(setup.tech.agent, setup.batch.id)).status).toBe(200);
    expect(partStatus(harness, setup.serials[0])).toBe("available");
  });
});

/**
 * Ticket 03: close settlement is status-aware — the device's terminal Repair
 * Status decides where its still-Reserved parts go (Repaired: Buybackable →
 * the Buyback pool, everything else consumed; Unrepairable: everything back
 * to Available; Additional issues present / Denied Repair: nothing left to
 * settle). Every terminal status × Buybackable/non-Buybackable is covered.
 */
describe("close settlement is status-aware", () => {
  let harness: TestHarness;
  afterEach(() => harness?.close());

  /** A batch with two devices: one holding a Buybackable-SKU part, one a plain-SKU part. */
  async function setupTwoSkus() {
    const harness = createTestHarness();
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const manager = await harness.loginAs(MANAGER);
    const buybackSku = await createSku(tech.agent, {
      name: "iPhone 13 Screen (buyback program)",
      buybackable: true,
    });
    const plainSku = await createSku(tech.agent, { name: "iPhone 13 Housing" });
    const [bbSerial] = await intakeParts(tech.agent, buybackSku.id, 1);
    const [plainSerial] = await intakeParts(tech.agent, plainSku.id, 1);
    const batch = await createBatch(tech.agent);
    const bbDevice = await addDevice(tech.agent, batch.id, { imei: "111111111111111" });
    const plainDevice = await addDevice(tech.agent, batch.id, { imei: "222222222222222" });
    expect((await addPart(tech.agent, batch.id, bbDevice.id, { skuId: buybackSku.id })).status).toBe(201);
    expect((await addPart(tech.agent, batch.id, plainDevice.id, { skuId: plainSku.id })).status).toBe(201);
    // NOT approved here: the Denied-Repair test rejects at approval, and the
    // per-device decisions only exist while the batch is Awaiting approval.
    return { harness, tech, manager, batch, bbDevice, plainDevice, bbSerial, plainSerial };
  }

  function closeStatusEvents(h: TestHarness): Array<Record<string, unknown>> {
    return (
      h.db
        .prepare(
          "SELECT payload FROM events WHERE entity_type = 'part' AND action = 'part.status_changed' ORDER BY id"
        )
        .all() as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload));
  }

  it("a Repaired device sends its Buybackable part to the Buyback pool and consumes the rest", async () => {
    const setup = await setupTwoSkus();
    harness = setup.harness;
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);
    for (const device of [setup.bbDevice, setup.plainDevice]) {
      expect((await setStatus(setup.tech.agent, setup.batch.id, device.id, "In progress")).status).toBe(200);
      expect(
        (await setStatus(setup.tech.agent, setup.batch.id, device.id, "Repaired", "Done.")).status
      ).toBe(200);
    }
    expect((await closeBatch(setup.tech.agent, setup.batch.id)).status).toBe(200);
    // The replaced screen is worth money back; the plain part has no value to recover.
    expect(partStatus(harness, setup.bbSerial)).toBe("buyback");
    expect(partStatus(harness, setup.plainSerial)).toBe("unavailable");
    const events = closeStatusEvents(harness);
    expect(events).toContainEqual(
      expect.objectContaining({
        serial: setup.bbSerial,
        from: "reserved",
        to: "buyback",
        reason: "batch_closed_repaired_buyback",
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        serial: setup.plainSerial,
        from: "reserved",
        to: "unavailable",
        reason: "batch_closed_repaired_unavailable",
      })
    );
  });

  it("an Unrepairable device returns every applied part to Available — Buybackable included", async () => {
    const setup = await setupTwoSkus();
    harness = setup.harness;
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);
    for (const device of [setup.bbDevice, setup.plainDevice]) {
      expect((await setStatus(setup.tech.agent, setup.batch.id, device.id, "In progress")).status).toBe(200);
      expect(
        (await setStatus(setup.tech.agent, setup.batch.id, device.id, "Unrepairable", "Board is dead."))
          .status
      ).toBe(200);
    }
    expect((await closeBatch(setup.tech.agent, setup.batch.id)).status).toBe(200);
    // The repair is reversed: nothing was replaced, so both units are good stock going home.
    expect(partStatus(harness, setup.bbSerial)).toBe("available");
    expect(partStatus(harness, setup.plainSerial)).toBe("available");
    for (const serial of [setup.bbSerial, setup.plainSerial]) {
      expect(closeStatusEvents(harness)).toContainEqual(
        expect.objectContaining({
          serial,
          from: "reserved",
          to: "available",
          reason: "batch_closed_unrepairable_available",
        })
      );
    }
  });

  it("Additional issues present leaves its parts Reserved on the continuation device — the old batch closes around them", async () => {
    const setup = await setupTwoSkus();
    harness = setup.harness;
    expect((await approveBatch(setup.manager.agent, setup.batch.id)).status).toBe(200);
    expect(
      (await setStatus(setup.tech.agent, setup.batch.id, setup.bbDevice.id, "In progress")).status
    ).toBe(200);
    const response = await setStatus(
      setup.tech.agent,
      setup.batch.id,
      setup.bbDevice.id,
      "Additional issues present",
      "Board damage found — needs micro-soldering."
    );
    expect(response.status).toBe(200);
    const retriagedTo = response.body.retriagedTo as { deviceId: number };
    // The OTHER device finishes normally so the old batch can close.
    expect(
      (await setStatus(setup.tech.agent, setup.batch.id, setup.plainDevice.id, "In progress")).status
    ).toBe(200);
    expect(
      (await setStatus(setup.tech.agent, setup.batch.id, setup.plainDevice.id, "Repaired", "Done."))
        .status
    ).toBe(200);
    expect((await closeBatch(setup.tech.agent, setup.batch.id)).status).toBe(200);
    // The carried part is Buybackable, but close does NOT send it to Buyback:
    // it was never replaced — it belongs to the continuation device's run.
    expect(partStatus(harness, setup.bbSerial)).toBe("reserved");
    const attachment = harness.db
      .prepare(
        "SELECT device_id, removed_at FROM device_parts WHERE part_id = (SELECT id FROM serialized_parts WHERE serial = ?)"
      )
      .get(setup.bbSerial) as { device_id: number; removed_at: null };
    expect(attachment).toEqual({ device_id: retriagedTo.deviceId, removed_at: null });
    // The old batch's close settlement touched only the device that stayed.
    expect(closeStatusEvents(harness)).toEqual([
      expect.objectContaining({
        serial: setup.plainSerial,
        to: "unavailable",
        reason: "batch_closed_repaired_unavailable",
      }),
    ]);
  });

  it("a Denied-Repair device's parts were already returned at approval — close re-settles nothing", async () => {
    const setup = await setupTwoSkus();
    harness = setup.harness;
    await decideAll(setup.manager.agent, setup.batch.id, "rejected");
    const approved = await setup.manager.agent
      .post(`/api/batches/${setup.batch.id}/approve`)
      .send({ note: "both denied — customer recalled the units" });
    expect(approved.status).toBe(200);
    // The denial return happened at approval, before close.
    expect(partStatus(harness, setup.bbSerial)).toBe("available");
    expect(partStatus(harness, setup.plainSerial)).toBe("available");
    expect((await closeBatch(setup.tech.agent, setup.batch.id)).status).toBe(200);
    expect(partStatus(harness, setup.bbSerial)).toBe("available");
    expect(partStatus(harness, setup.plainSerial)).toBe("available");
    // The close settlement had nothing to settle and says so loudly.
    const closedEvent = JSON.parse(
      (
        harness.db.prepare("SELECT payload FROM events WHERE action = 'batch.closed'").get() as {
          payload: string;
        }
      ).payload
    );
    expect(closedEvent.settled).toEqual([]);
    expect(closedEvent.alreadyUnavailable).toEqual([]);
  });

  it("the Reserved→Buyback primitive refuses a non-buybackable SKU loudly — the guard every caller shares", async () => {
    const setup = await setupTwoSkus();
    harness = setup.harness;
    // The plain part is Reserved through its active device_parts attachment.
    const partId = (
      harness.db
        .prepare("SELECT id FROM serialized_parts WHERE serial = ?")
        .get(setup.plainSerial) as { id: number }
    ).id;
    expect(() => movePartFromReserved(harness.db, partId, "buyback")).toThrow(/not buybackable/);
    // The guard refused BEFORE any write — the part is untouched.
    expect(partStatus(harness, setup.plainSerial)).toBe("reserved");
    expect(movePartFromReserved(harness.db, partId, "unavailable")).toBe(true);
  });
});

describe("retriage", () => {
  let harness: TestHarness;
  afterEach(() => harness?.close());

  it("Additional issues present carries reserved parts and open demand onto a new batch's device row", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    const { tech, batch, device, sku, serials } = setup;

    // The device also waits on a second part that has no stock — an open demand.
    const shortSku = await createSku(tech.agent, BATTERY);
    const demanded = await addPart(tech.agent, batch.id, device.id, { skuId: shortSku.id });
    expect(demanded.body.outcome).toBe("need_to_order");
    const demandId = (demanded.body.demand as { id: number }).id;

    expect((await approveBatch(setup.manager.agent, batch.id)).status).toBe(200);
    expect((await setStatus(tech.agent, batch.id, device.id, "In progress")).status).toBe(200);

    const response = await setStatus(
      tech.agent,
      batch.id,
      device.id,
      "Additional issues present",
      "Board damage found — needs a micro-soldering run."
    );
    expect(response.status).toBe(200);
    const retriagedTo = response.body.retriagedTo as {
      batchId: number;
      batchNumber: number;
      deviceId: number;
    };
    expect(retriagedTo.batchNumber).toBe(batch.number + 1);

    // The old run is over: terminal on batch A, no active parts left there.
    const oldDevice = (await tech.agent.get(`/api/batches/${batch.id}`)).body as {
      devices: DeviceJson[];
    };
    expect(oldDevice.devices[0].repairStatus).toBe("Additional issues present");

    // The new batch exists, is Awaiting approval (fresh approval required), and
    // holds the carried-over device row.
    const newDetail = (await tech.agent.get(`/api/batches/${retriagedTo.batchId}`)).body as {
      status: string;
      number: number;
      devices: DeviceJson[];
    };
    expect(newDetail.status).toBe("Awaiting approval");
    expect(newDetail.number).toBe(batch.number + 1);
    const carried = newDetail.devices[0];
    expect(carried.id).toBe(retriagedTo.deviceId);
    expect(carried.priorDeviceId).toBe(device.id);
    expect(carried.imei).toBe("111111111111111");
    expect(carried.repairStatus).toBe("Awaiting repair");

    // Still Reserved, still the same snapshotted price — now on the new row.
    expect(partStatus(harness, serials[0])).toBe("reserved");
    const attachment = harness.db
      .prepare("SELECT device_id, removed_at FROM device_parts WHERE part_id = (SELECT id FROM serialized_parts WHERE serial = ?)")
      .get(serials[0]) as { device_id: number; removed_at: null };
    expect(attachment).toEqual({ device_id: carried.id, removed_at: null });

    // The open demand followed the device to the new batch.
    const demand = harness.db
      .prepare("SELECT batch_id, device_id, status FROM demand_records WHERE id = ?")
      .get(demandId) as { batch_id: number; device_id: number; status: string };
    expect(demand).toEqual({ batch_id: retriagedTo.batchId, device_id: carried.id, status: "open" });

    // The carry-over is on the timelines.
    const events = harness.db
      .prepare("SELECT entity_type, action, payload FROM events WHERE action IN ('device.retriaged', 'device.retriaged_in', 'part.transferred') ORDER BY id")
      .all() as Array<{ entity_type: string; payload: string }>;
    const payloads = events.map((event) => JSON.parse(event.payload));
    expect(payloads).toContainEqual(
      expect.objectContaining({ toBatchId: retriagedTo.batchId, toDeviceId: carried.id })
    );
    expect(payloads).toContainEqual(expect.objectContaining({ serial: serials[0], reason: "retriage" }));

    // The old batch can now close — its device is terminal.
    expect((await closeBatch(setup.manager.agent, batch.id)).status).toBe(200);
    expect(partStatus(harness, serials[0])).toBe("reserved");
  });

  it("the carried-over parts require fresh approval on the new batch", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    const { tech, manager, batch, device, sku } = setup;

    expect((await approveBatch(manager.agent, batch.id)).status).toBe(200);
    expect((await setStatus(tech.agent, batch.id, device.id, "In progress")).status).toBe(200);
    const response = await setStatus(
      tech.agent,
      batch.id,
      device.id,
      "Additional issues present",
      "More damage found."
    );
    const retriagedTo = response.body.retriagedTo as { batchId: number; deviceId: number };

    // Repair cannot proceed on the new batch before a manager signs off again.
    const blocked = await setStatus(tech.agent, retriagedTo.batchId, retriagedTo.deviceId, "In progress");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain("Awaiting approval");

    expect((await approveBatch(manager.agent, retriagedTo.batchId)).status).toBe(200);
    const proceeds = await setStatus(tech.agent, retriagedTo.batchId, retriagedTo.deviceId, "In progress");
    expect(proceeds.status).toBe(200);

    // Pre-approval part edits on the new batch are free again (fresh approval).
    const secondBatch = await createBatch(tech.agent);
    const secondDevice = await addDevice(tech.agent, secondBatch.id);
    expect(
      (await addPart(tech.agent, secondBatch.id, secondDevice.id, { skuId: sku.id })).status
    ).toBe(201);
  });

  it("retriage works without parts and history links device rows across batches", async () => {
    const setup = await setupBatchWithPart();
    harness = setup.harness;
    const { tech, batch, device } = setup;

    expect((await approveBatch(setup.manager.agent, batch.id)).status).toBe(200);
    expect((await setStatus(tech.agent, batch.id, device.id, "In progress")).status).toBe(200);
    const response = await setStatus(
      tech.agent,
      batch.id,
      device.id,
      "Additional issues present",
      "Additional fault discovered."
    );
    const retriagedTo = response.body.retriagedTo as {
      batchId: number;
      batchNumber: number;
      deviceId: number;
    };

    // A third batch whose device shares only the IMEI also shows up in history.
    const third = await createBatch(tech.agent);
    const thirdDevice = await addDevice(tech.agent, third.id, { imei: "999999999999999" });
    await tech.agent
      .patch(`/api/batches/${third.id}/devices/${thirdDevice.id}`)
      .send({ imei: "111111111111111" });

    const history = (
      await tech.agent.get(`/api/batches/${batch.id}/devices/${device.id}/history`)
    ).body as {
      history: Array<{
        id: number;
        batchNumber: number;
        imei: string | null;
        repairStatus: string;
        priorDeviceId: number | null;
      }>;
    };
    const entries = history.history.map((entry) => entry.id).sort((a, b) => a - b);
    expect(entries).toEqual([retriagedTo.deviceId, thirdDevice.id].sort((a, b) => a - b));
    const carried = history.history.find((entry) => entry.id === retriagedTo.deviceId)!;
    expect(carried.batchNumber).toBe(retriagedTo.batchNumber);
    expect(carried.priorDeviceId).toBe(device.id);

    // And the history is symmetrical: the new row links back to the old one.
    const back = (
      await tech.agent.get(`/api/batches/${retriagedTo.batchId}/devices/${retriagedTo.deviceId}/history`)
    ).body as { history: Array<{ id: number }> };
    expect(back.history.map((entry) => entry.id)).toContain(device.id);
  });
});
