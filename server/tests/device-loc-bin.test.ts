import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";

/**
 * Ticket 08 — the device Loc/Bin field.
 *
 * Rules under test:
 * - ONE optional free-text field (combined "Loc/Bin", not two), nullable;
 *   any tech sets or clears it INLINE through the device edit route with NO
 *   note — it is a current-state field, not an event-carrying change.
 * - A loc/bin edit writes NO timeline event — not on its own, and not as a
 *   field entry inside a device.edited event edited alongside other fields.
 * - Device search (GET /api/search) matches loc/bin as a case-insensitive
 *   SUBSTRING (the SKU rule — free text, partial recall is the norm), with
 *   LIKE wildcards escaped like every other substring search.
 */

type Agent = LoggedInAgent["agent"];

interface DeviceJson {
  id: number;
  batchId: number;
  locBin: string | null;
}

async function createBatch(agent: Agent): Promise<{ id: number }> {
  const response = await agent.post("/api/batches").send({ note: "batch for loc/bin" });
  expect(response.status).toBe(201);
  return response.body as { id: number };
}

async function addDevice(
  agent: Agent,
  batchId: number,
  overrides: Record<string, unknown> = {}
): Promise<DeviceJson> {
  const response = await agent.post(`/api/batches/${batchId}/devices`).send({
    modelName: "iPhone 13",
    statedIssue: "Cracked screen",
    imei: "359175920074058",
    ...overrides,
  });
  expect(response.status).toBe(201);
  return response.body as DeviceJson;
}

function patchLocBin(agent: Agent, batchId: number, deviceId: number, body: Record<string, unknown>) {
  return agent.patch(`/api/batches/${batchId}/devices/${deviceId}`).send(body);
}

/** The device's timeline events, straight from the one events table. */
function deviceEvents(harness: TestHarness, deviceId: number): Array<{ action: string; payload: string | null }> {
  return harness.db
    .prepare(
      "SELECT action, payload FROM events WHERE entity_type = 'device' AND entity_id = ? ORDER BY id"
    )
    .all(deviceId) as Array<{ action: string; payload: string | null }>;
}

describe("ticket 08 — device loc/bin", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    // Any tech may edit — loc/bin is never manager-gated (current state).
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });
  afterEach(() => harness.close());

  it("a tech sets loc/bin inline with no note, and the batch detail carries it", async () => {
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id);

    const patched = await patchLocBin(tech.agent, batch.id, device.id, {
      locBin: "Shelf 3 / Bin B",
    });
    expect(patched.status).toBe(200);
    expect((patched.body as DeviceJson).locBin).toBe("Shelf 3 / Bin B");

    const detail = await tech.agent.get(`/api/batches/${batch.id}`);
    const row = (detail.body as { devices: DeviceJson[] }).devices.find((d) => d.id === device.id);
    expect(row?.locBin).toBe("Shelf 3 / Bin B");
  });

  it("an unset loc/bin serializes as null (the UI renders it as '—', never a silent blank)", async () => {
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id);
    expect(device.locBin).toBeNull();
  });

  it("present-but-empty clears the field (PATCH semantics)", async () => {
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { locBin: "Shelf 3 / Bin B" });

    const patched = await patchLocBin(tech.agent, batch.id, device.id, { locBin: "" });
    expect(patched.status).toBe(200);
    expect((patched.body as DeviceJson).locBin).toBeNull();
  });

  it("a loc/bin-only edit writes NO timeline event", async () => {
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id);
    expect(deviceEvents(harness, device.id).map((e) => e.action)).toEqual(["device.created"]);

    const patched = await patchLocBin(tech.agent, batch.id, device.id, { locBin: "Bench 2" });
    expect(patched.status).toBe(200);
    // Current state, not history: the row changed, the timeline did not.
    expect(deviceEvents(harness, device.id).map((e) => e.action)).toEqual(["device.created"]);
  });

  it("a loc/bin edit alongside other fields never appears in the device.edited payload", async () => {
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id);

    const patched = await patchLocBin(tech.agent, batch.id, device.id, {
      statedIssue: "Cracked screen AND dead battery",
      locBin: "Bench 2",
    });
    expect(patched.status).toBe(200);

    const edited = deviceEvents(harness, device.id).filter((e) => e.action === "device.edited");
    expect(edited).toHaveLength(1);
    const payload = JSON.parse(edited[0].payload as string) as { fields: Record<string, unknown> };
    // The other field is evented old → new; loc/bin deliberately is not.
    expect(Object.keys(payload.fields)).toEqual(["statedIssue"]);
    expect((patched.body as DeviceJson).locBin).toBe("Bench 2");
  });

  it("creation accepts the field", async () => {
    const batch = await createBatch(tech.agent);
    const device = await addDevice(tech.agent, batch.id, { locBin: "Receiving desk" });
    expect(device.locBin).toBe("Receiving desk");
  });
});

describe("ticket 08 — device search matches loc/bin as a substring", () => {
  let harness: TestHarness;
  let tech: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    tech = await harness.createUserAs("tech@acme.co", "tech");
  });
  afterEach(() => harness.close());

  it("finds a device by a case-insensitive loc/bin substring", async () => {
    const batch = await createBatch(tech.agent);
    const located = await addDevice(tech.agent, batch.id, { imei: "359175920074058" });
    await addDevice(tech.agent, batch.id, { imei: "359175920074059" });

    const set = await patchLocBin(tech.agent, batch.id, located.id, {
      locBin: "Shelf 3 / Bin B",
    });
    expect(set.status).toBe(200);

    for (const query of ["bin b", "BIN B", "shelf", "lf 3 /"]) {
      const response = await tech.agent.get("/api/search").query({ q: query });
      expect(response.status).toBe(200);
      const hits = (response.body as { results: { devices: Array<{ id: number; locBin: string | null }> } })
        .results.devices;
      expect(hits.map((d) => d.id)).toEqual([located.id]);
      // The hit carries the location so the results row can show it.
      expect(hits[0].locBin).toBe("Shelf 3 / Bin B");
    }
  });

  it("does not match devices whose loc/bin is unset, and never by identifier text alone", async () => {
    const batch = await createBatch(tech.agent);
    await addDevice(tech.agent, batch.id, { imei: "359175920074058" });

    const response = await tech.agent.get("/api/search").query({ q: "bin" });
    expect(response.status).toBe(200);
    expect((response.body as { results: { devices: unknown[] } }).results.devices).toEqual([]);
  });

  it("escapes LIKE wildcards — '_' matches literally, like every substring search here", async () => {
    const batch = await createBatch(tech.agent);
    const underscore = await addDevice(tech.agent, batch.id, { imei: "359175920074058" });
    const letter = await addDevice(tech.agent, batch.id, { imei: "359175920074059" });
    await patchLocBin(tech.agent, batch.id, underscore.id, { locBin: "Bin_1" });
    await patchLocBin(tech.agent, batch.id, letter.id, { locBin: "BinX1" });

    // "n_1" with a real underscore: only Bin_1 matches (an unescaped _
    // would match BinX1 too).
    const response = await tech.agent.get("/api/search").query({ q: "n_1" });
    expect(response.status).toBe(200);
    const hits = (response.body as { results: { devices: Array<{ id: number }> } }).results.devices;
    expect(hits.map((d) => d.id)).toEqual([underscore.id]);
  });
});
