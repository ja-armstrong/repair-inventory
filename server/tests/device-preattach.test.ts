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
 * Device creation with pre-attached SKUs (the add-device modal's "parts it
 * will need"): the device enters the batch with every picked SKU attached —
 * through THE reservation core (batchparts/attach.ts), inside the SAME
 * transaction as the device row. Atomic: any refusal rolls the whole
 * creation back, so a device never enters the batch half-equipped.
 */

const SCREEN = { name: "iPhone 13 Screen", price: "109.99", kind: "serialized" };
const BATTERY = { name: "iPhone 13 Battery", price: "45.00", kind: "serialized" };
const ADHESIVE = { name: "Adhesive strips", price: "1.50", kind: "consumable" };

interface DeviceJson {
  id: number;
  repairStatus: string;
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
  return response.body as { id: number; priceCents: number };
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

async function createBatch(agent: Agent, note = "pre-attach") {
  const response = await agent.post("/api/batches").send({ note });
  expect(response.status).toBe(201);
  return response.body as { id: number; number: number };
}

async function addDevice(
  agent: Agent,
  batchId: number,
  body: Record<string, unknown> = {}
) {
  return agent.post(`/api/batches/${batchId}/devices`).send({
    modelName: "iPhone 13",
    statedIssue: "Cracked screen",
    imei: "359175920074058",
    ...body,
  });
}

async function batchDetail(agent: Agent, batchId: number): Promise<BatchJson> {
  const response = await agent.get(`/api/batches/${batchId}`);
  expect(response.status).toBe(200);
  return response.body as BatchJson;
}

function partStatus(harness: TestHarness, serial: string): string {
  return (harness.db.prepare("SELECT status FROM serialized_parts WHERE serial = ?").get(serial) as {
    status: string;
  }).status;
}

describe("device creation with pre-attached SKUs", () => {
  let harness: TestHarness;
  let manager: LoggedInAgent;

  beforeEach(async () => {
    harness = createTestHarness();
    manager = await harness.loginAs(MANAGER);
  });

  afterEach(() => {
    harness.close();
  });

  it("the device enters the batch with the picked SKUs attached — oldest units reserved", async () => {
    const screen = await createSku(manager.agent);
    const battery = await createSku(manager.agent, BATTERY);
    const screenSerials = await intakeParts(manager.agent, screen.id, 2);
    const batterySerials = await intakeParts(manager.agent, battery.id, 1);
    const batch = await createBatch(manager.agent);

    const response = await addDevice(manager.agent, batch.id, {
      imei: "111111111111111",
      preAttach: [{ skuId: screen.id }, { skuId: battery.id }],
    });
    expect(response.status).toBe(201);
    const device = response.body as DeviceJson;

    const detail = await batchDetail(manager.agent, batch.id);
    expect(detail.devices).toHaveLength(1);
    expect(detail.devices[0].repairStatus).toBe("Awaiting repair");

    // Both SKUs attached: the oldest screen unit and the only battery.
    const parts = await manager.agent.get(`/api/batches/${batch.id}/parts`);
    const deviceParts = (parts.body as {
      devices: Array<{
        deviceId: number;
        parts: Array<{ part: { serial: string }; sku: { id: number }; removedAt: string | null }>;
        demand: Array<{ status: string }>;
      }>;
    }).devices.find((d) => d.deviceId === device.id)!;
    const attached = deviceParts.parts.filter((p) => p.removedAt === null);
    expect(attached).toHaveLength(2);
    expect(attached.find((p) => p.sku.id === screen.id)!.part.serial).toBe(screenSerials[0]);
    expect(attached.find((p) => p.sku.id === battery.id)!.part.serial).toBe(batterySerials[0]);
    expect(deviceParts.demand).toHaveLength(0);
    expect(partStatus(harness, screenSerials[0])).toBe("reserved");
    expect(partStatus(harness, screenSerials[1])).toBe("available");

    // The timeline reads like the parts were added one at a time: created,
    // then each reservation.
    const events = harness.db
      .prepare(
        "SELECT action FROM events WHERE entity_type = 'device' AND entity_id = ? ORDER BY id"
      )
      .all(device.id) as Array<{ action: string }>;
    expect(events[0].action).toBe("device.created");
    expect(events.filter((e) => e.action === "device.part_reserved")).toHaveLength(2);
  });

  it("a SKU with no stock becomes a Need to Order — the device enters blocked in Parts needed", async () => {
    const screen = await createSku(manager.agent); // no intake — no stock
    const batch = await createBatch(manager.agent);

    const response = await addDevice(manager.agent, batch.id, {
      imei: "222222222222222",
      preAttach: [{ skuId: screen.id }],
    });
    expect(response.status).toBe(201);
    const device = response.body as DeviceJson;

    const detail = await batchDetail(manager.agent, batch.id);
    expect(detail.devices[0].repairStatus).toBe("Parts needed");
    const demandRow = harness.db
      .prepare("SELECT status, device_id FROM demand_records WHERE batch_id = ?")
      .get(batch.id) as { status: string; device_id: number };
    expect(demandRow.status).toBe("open");
    expect(demandRow.device_id).toBe(device.id);
  });

  it("mixed: one SKU with stock, one without — attachment AND demand in one creation", async () => {
    const screen = await createSku(manager.agent);
    const battery = await createSku(manager.agent, BATTERY); // no stock
    const [serial] = await intakeParts(manager.agent, screen.id, 1);
    const batch = await createBatch(manager.agent);

    const response = await addDevice(manager.agent, batch.id, {
      imei: "333333333333333",
      preAttach: [{ skuId: screen.id }, { skuId: battery.id }],
    });
    expect(response.status).toBe(201);
    const device = response.body as DeviceJson;

    expect(partStatus(harness, serial)).toBe("reserved");
    const detail = await batchDetail(manager.agent, batch.id);
    expect(detail.devices[0].repairStatus).toBe("Parts needed");
  });

  it("a CONSUMABLE entry records usage — the cost lands on the device, the item is not reserved", async () => {
    const adhesive = await createSku(manager.agent, ADHESIVE); // $1.50, no stock count
    const batch = await createBatch(manager.agent);

    const response = await addDevice(manager.agent, batch.id, {
      imei: "171717171717171",
      preAttach: [{ skuId: adhesive.id, quantity: 2 }],
    });
    expect(response.status).toBe(201);
    const device = response.body as DeviceJson;

    // The usage row carries the quantity and the SKU's unit price.
    const usage = harness.db
      .prepare("SELECT quantity, unit_price_cents FROM device_consumables WHERE device_id = ?")
      .get(device.id) as { quantity: number; unit_price_cents: number };
    expect(usage).toEqual({ quantity: 2, unit_price_cents: 150 });

    // Parts Cost includes the usage (2 × 1.50) — the cost is tracked even
    // though the item has no units.
    const parts = await manager.agent.get(`/api/batches/${batch.id}/parts`);
    const deviceParts = (parts.body as {
      devices: Array<{ deviceId: number; partsCostCents: number; parts: unknown[] }>;
    }).devices.find((d) => d.deviceId === device.id)!;
    expect(deviceParts.partsCostCents).toBe(300);
    expect(deviceParts.parts).toHaveLength(0); // nothing reserved

    // Default quantity is 1 when omitted.
    const one = await addDevice(manager.agent, batch.id, {
      imei: "181818181818181",
      preAttach: [{ skuId: adhesive.id }],
    });
    expect(one.status).toBe(201);
    const second = harness.db
      .prepare(
        "SELECT quantity FROM device_consumables WHERE device_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get((one.body as DeviceJson).id) as { quantity: number };
    expect(second.quantity).toBe(1);
  });

  it("atomic: a refused entry rolls the WHOLE creation back — no half-equipped device", async () => {
    const screen = await createSku(manager.agent);
    await intakeParts(manager.agent, screen.id, 1);
    const adhesive = await createSku(manager.agent, ADHESIVE);
    const batch = await createBatch(manager.agent);

    // A quantity on a SERIALIZED entry is refused — quantities belong to
    // consumables — and the whole creation rolls back.
    const quantityOnSerialized = await addDevice(manager.agent, batch.id, {
      imei: "444444444444444",
      preAttach: [{ skuId: screen.id, quantity: 2 }],
    });
    expect(quantityOnSerialized.status).toBe(400);
    expect((quantityOnSerialized.body as { error: string }).error).toContain(
      "quantity belongs to a consumable",
    );

    const detail = await batchDetail(manager.agent, batch.id);
    expect(detail.devices).toHaveLength(0);
    const screenRow = harness.db
      .prepare("SELECT status FROM serialized_parts WHERE sku_id = ?")
      .get(screen.id) as { status: string };
    expect(screenRow.status).toBe("available"); // never reserved

    // A scanned serial with a quantity is refused at the schema.
    const serialWithQuantity = await addDevice(manager.agent, batch.id, {
      imei: "191919191919191",
      preAttach: [{ serial: "P00001", quantity: 2 }],
    });
    expect(serialWithQuantity.status).toBe(400);

    // An unknown SKU id is refused the same way — nothing created.
    const unknown = await addDevice(manager.agent, batch.id, {
      imei: "555555555555555",
      preAttach: [{ skuId: 99999 }],
    });
    expect(unknown.status).toBe(404);
    expect((await batchDetail(manager.agent, batch.id)).devices).toHaveLength(0);
    expect(
      (harness.db.prepare("SELECT COUNT(*) AS n FROM device_consumables").get() as { n: number }).n
    ).toBe(0);
  });

  it("on an OPEN batch the same rules apply: note required, price add limit enforced — and a manager's pre-attach amends the approval", async () => {
    const screen = await createSku(manager.agent);
    await intakeParts(manager.agent, screen.id, 3);
    const batch = await createBatch(manager.agent);
    const first = await addDevice(manager.agent, batch.id, { imei: "666666666666666" });
    expect(first.status).toBe(201);
    // Give the first device its part BEFORE approval, so the amendment math
    // below is a real delta: 109.99 signed off, then +109.99 pre-attached.
    expect(
      (
        await manager.agent
          .post(`/api/batches/${batch.id}/devices/${first.body.id}/parts`)
          .send({ skuId: screen.id })
      ).status
    ).toBe(201);

    // Approve (every device decided; the cost signs off at 109.99).
    const detail0 = await batchDetail(manager.agent, batch.id);
    for (const device of detail0.devices) {
      await manager.agent
        .post(`/api/batches/${batch.id}/devices/${device.id}/approval`)
        .send({ decision: "approved" });
    }
    expect((await manager.agent.post(`/api/batches/${batch.id}/approve`).send({ note: "ok" })).status).toBe(200);
    expect((await batchDetail(manager.agent, batch.id)).approvedCostCents).toBe(10999);

    // A tech's pre-attach on the Open batch: default limit 0 → the price
    // gate refuses, and the device is NOT created.
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const techRefused = await addDevice(tech.agent, batch.id, {
      imei: "777777777777777",
      preAttach: [{ skuId: screen.id }],
    });
    expect(techRefused.status).toBe(409);
    expect((techRefused.body as { error: string }).error).toContain("price add limit");
    expect((await batchDetail(manager.agent, batch.id)).devices).toHaveLength(1);

    // A manager pre-attaching WITHOUT a note: accepted — the amendment event
    // itself records that the approval moved (the note is optional now).
    // Created, attached, and the standing approval amended.
    const ok = await addDevice(manager.agent, batch.id, {
      imei: "888888888888888",
      preAttach: [{ skuId: screen.id }],
    });
    expect(ok.status).toBe(201);

    const detail = await batchDetail(manager.agent, batch.id);
    expect(detail.devices).toHaveLength(2);
    // 109.99 signed off before + 109.99 pre-attached and amended in.
    expect(detail.approvedCostCents).toBe(2 * 10999);
  });

  it("on an Awaiting-approval batch no note is needed — triage attaches freely", async () => {
    const screen = await createSku(manager.agent);
    await intakeParts(manager.agent, screen.id, 1);
    const batch = await createBatch(manager.agent);
    const response = await addDevice(manager.agent, batch.id, {
      imei: "999999999999999",
      preAttach: [{ skuId: screen.id }],
    });
    expect(response.status).toBe(201);
    const detail = await batchDetail(manager.agent, batch.id);
    expect(detail.devices).toHaveLength(1);
  });

  it("pre-attach by SCANNED SERIAL reserves that exact unit — not the oldest Available", async () => {
    const screen = await createSku(manager.agent);
    const [oldest, newest] = await intakeParts(manager.agent, screen.id, 2);
    const batch = await createBatch(manager.agent);

    const response = await addDevice(manager.agent, batch.id, {
      imei: "101010101010101",
      preAttach: [{ serial: newest }],
    });
    expect(response.status).toBe(201);
    const device = response.body as DeviceJson;

    const parts = await manager.agent.get(`/api/batches/${batch.id}/parts`);
    const deviceParts = (parts.body as {
      devices: Array<{ deviceId: number; parts: Array<{ part: { serial: string }; removedAt: string | null }> }>;
    }).devices.find((d) => d.deviceId === device.id)!;
    const attached = deviceParts.parts.filter((p) => p.removedAt === null);
    expect(attached).toHaveLength(1);
    expect(attached[0].part.serial).toBe(newest);
    expect(partStatus(harness, newest)).toBe("reserved");
    expect(partStatus(harness, oldest)).toBe("available");

    // The event records the scan as the source, like the parts panel does.
    const event = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'part' AND action = 'part.reserved' ORDER BY id DESC LIMIT 1"
      )
      .get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ via: "serial_scan" });
  });

  it("an unknown or already-reserved serial rolls the WHOLE creation back", async () => {
    const screen = await createSku(manager.agent);
    const [serial] = await intakeParts(manager.agent, screen.id, 1);
    const batch = await createBatch(manager.agent);

    const unknown = await addDevice(manager.agent, batch.id, {
      imei: "121212121212121",
      preAttach: [{ serial: "P999999" }],
    });
    expect(unknown.status).toBe(404);
    expect((await batchDetail(manager.agent, batch.id)).devices).toHaveLength(0);

    // Reserve the unit by SKU first, then scan it in a pre-attach: refused,
    // nothing created.
    const other = await addDevice(manager.agent, batch.id, { imei: "131313131313131" });
    expect(other.status).toBe(201);
    expect(
      (
        await manager.agent
          .post(`/api/batches/${batch.id}/devices/${(other.body as DeviceJson).id}/parts`)
          .send({ skuId: screen.id })
      ).status
    ).toBe(201);

    const taken = await addDevice(manager.agent, batch.id, {
      imei: "141414141414141",
      preAttach: [{ serial }],
    });
    expect(taken.status).toBe(409);
    expect((taken.body as { error: string }).error).toContain("not Available");
    expect((await batchDetail(manager.agent, batch.id)).devices).toHaveLength(1);
    expect(partStatus(harness, serial)).toBe("reserved"); // untouched by the scan
  });

  it("a pre-attach entry with both a SKU and a serial — or neither — is refused loudly", async () => {
    const screen = await createSku(manager.agent);
    const [serial] = await intakeParts(manager.agent, screen.id, 1);
    const batch = await createBatch(manager.agent);

    const both = await addDevice(manager.agent, batch.id, {
      imei: "151515151515151",
      preAttach: [{ skuId: screen.id, serial }],
    });
    expect(both.status).toBe(400);
    expect((both.body as { error: string }).error).toContain("exactly one");

    const neither = await addDevice(manager.agent, batch.id, {
      imei: "161616161616161",
      preAttach: [{}],
    });
    expect(neither.status).toBe(400);
    expect((await batchDetail(manager.agent, batch.id)).devices).toHaveLength(0);
  });
});
