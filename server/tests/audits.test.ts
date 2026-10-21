import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTestHarness,
  DEFAULT_MANAGER_EMAIL,
  FakeClock,
  type LoggedInAgent,
  type TestHarness,
} from "./harness.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { addMonthsUTC, auditSchedule } from "../domains/audits/schedule.js";

const MANAGER = DEFAULT_MANAGER_EMAIL;
type Agent = LoggedInAgent["agent"];

/**
 * Ticket 10: audits and cycle counts. Everything drives the HTTP API seam
 * with a throwaway SQLite file and the injectable FakeClock — due-ness,
 * banners, and no-grace settlement are all time-driven, so the clock moves
 * and nothing sleeps.
 *
 * The worked example (spec story 66) is pinned by its own test: with a
 * 2-month interval and audits on 01.01 and 03.01, a part counted 02.01 is
 * exempt at the 03.01 audit but due again at 05.01 if never counted again.
 */

interface SkuJson {
  id: number;
  name: string;
  kind: "serialized" | "consumable";
}

interface PartViewJson {
  id: number;
  serial: string;
  skuId: number;
  skuName: string;
  status: string;
  statusLabel: string;
  lastCountedAt: string | null;
}

interface ExemptPartJson extends PartViewJson {
  reason: string;
}

interface AuditDetailJson {
  id: number;
  scheduledAt: string | null;
  openedAt: string;
  closedAt: string | null;
  openedBy: { id: number; email: string } | null;
  closedBy: { id: number; email: string } | null;
  previousAuditId: number | null;
  anchorAt: string | null;
  intervalMonths: number;
  open: boolean;
  summary: { demanded: number; counted: number; failed: number; moved: number };
  parts: {
    due: PartViewJson[];
    counted: PartViewJson[];
    scanned: PartViewJson[];
    failed: PartViewJson[];
    moved: PartViewJson[];
    exempt: ExemptPartJson[];
  };
  events: Array<{ id: number; action: string; actor: { id: number; email: string } | null }>;
}

interface StatusJson {
  intervalMonths: number;
  lastAuditAt: string | null;
  nextAuditAt: string | null;
  openAuditId: number | null;
  banner: { stage: string | null };
}

async function createSku(agent: Agent, overrides: Record<string, unknown> = {}): Promise<SkuJson> {
  const response = await agent.post("/api/skus").send({
    name: "iPhone 13 Screen",
    price: "109.99",
    kind: "serialized",
    ...overrides,
  });
  expect(response.status).toBe(201);
  return response.body as SkuJson;
}

async function intakeParts(agent: Agent, skuId: number, count: number): Promise<string[]> {
  const response = await agent.post(`/api/skus/${skuId}/parts`).send({ source: "migration", quantity: count, counted: false });
  expect(response.status).toBe(201);
  return (response.body.parts as Array<{ serial: string }>).map((part) => part.serial);
}

function partStatus(harness: TestHarness, serial: string): string {
  const row = harness.db
    .prepare("SELECT status FROM serialized_parts WHERE serial = ?")
    .get(serial) as { status: string };
  return row?.status;
}

function lastCounted(harness: TestHarness, serial: string): string | null {
  const row = harness.db
    .prepare("SELECT last_counted_at FROM serialized_parts WHERE serial = ?")
    .get(serial) as { last_counted_at: string | null };
  return row?.last_counted_at;
}

function exemptFor(body: AuditDetailJson, serial: string): string | undefined {
  return body.parts.exempt.find((part) => part.serial === serial)?.reason;
}

function partEvent(
  harness: TestHarness,
  serial: string,
  action: string
): { actor_id: number; payload: string } | undefined {
  // ORDER BY id DESC: the LATEST event of this action — earlier ones may be
  // setup (e.g. the status change that made a part Unavailable in the first
  // place, before the scan-wins change under test).
  return harness.db
    .prepare(
      "SELECT actor_id, payload FROM events WHERE entity_type = 'part' AND entity_id = (SELECT id FROM serialized_parts WHERE serial = ?) AND action = ? ORDER BY id DESC LIMIT 1"
    )
    .get(serial, action) as { actor_id: number; payload: string } | undefined;
}

/** Sets a part's status directly — reservation is owned by the batch-parts domain (ticket 05). */
function forceStatus(harness: TestHarness, serial: string, status: string): void {
  harness.db
    .prepare("UPDATE serialized_parts SET status = ? WHERE serial = ?")
    .run(status, serial);
}

describe("the worked example (spec story 66)", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness({ now: "2026-01-01T12:00:00.000Z" });
  });
  afterEach(() => harness.close());

  it("a part counted 02.01 is exempt at the 03.01 audit but due again at 05.01", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [alpha, bravo, charlie] = await intakeParts(manager.agent, sku.id, 3);

    // 01.01 — the first audit: no previous audit, so everything in
    // circulation is demanded.
    const first = await manager.agent.post("/api/audits").send({});
    expect(first.status).toBe(201);
    expect(first.body.scheduledAt).toBeNull();
    expect(first.body.previousAuditId).toBeNull();
    expect(first.body.anchorAt).toBeNull();
    expect(first.body.open).toBe(true);
    expect(first.body.parts.due.map((part: PartViewJson) => part.serial)).toEqual([
      alpha,
      bravo,
      charlie,
    ]);

    // Count Alpha and Bravo during the window; Charlie stays unscanned.
    const scanA = await manager.agent.post(`/api/audits/${first.body.id}/scan`).send({ serial: alpha });
    expect(scanA.status).toBe(200);
    expect(scanA.body.statusChanged).toBe(false);
    await manager.agent.post(`/api/audits/${first.body.id}/scan`).send({ serial: bravo });

    let detail = await manager.agent.get(`/api/audits/${first.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.parts.due.map((part: PartViewJson) => part.serial)).toEqual([charlie]);
    expect(detail.body.parts.counted.map((part: PartViewJson) => part.serial).sort()).toEqual(
      [alpha, bravo].sort()
    );
    expect(lastCounted(harness, alpha)).toBe(harness.clock.now().toISOString());

    // Closing settles with no grace: Charlie was due but unscanned.
    const closed = await manager.agent.post(`/api/audits/${first.body.id}/close`).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.open).toBe(false);
    expect(closed.body.closedBy).toMatchObject({ email: MANAGER });
    expect(closed.body.parts.failed.map((part: PartViewJson) => part.serial)).toEqual([charlie]);
    expect(closed.body.parts.counted.map((part: PartViewJson) => part.serial).sort()).toEqual(
      [alpha, bravo].sort()
    );
    expect(closed.body.summary).toEqual({ demanded: 3, counted: 2, failed: 1, moved: 0 });

    // The shrink signal: Charlie became Unavailable, with an event that
    // names the audit it failed.
    expect(partStatus(harness, charlie)).toBe("unavailable");
    const failEvent = partEvent(harness, charlie, "part.status_changed");
    expect(failEvent?.actor_id).toBe(manager.user.id);
    expect(JSON.parse(failEvent!.payload)).toMatchObject({ from: "available", to: "unavailable" });
    expect(String(JSON.parse(failEvent!.payload).note)).toContain(`audit #${first.body.id}`);
    // A failed part was not counted — only scanned parts refresh last-count.
    expect(lastCounted(harness, charlie)).toBeNull();

    // The audit has its own timeline.
    const auditEvents = harness.db
      .prepare("SELECT action FROM events WHERE entity_type = 'audit' AND entity_id = ? ORDER BY id")
      .all(first.body.id) as Array<{ action: string }>;
    expect(auditEvents.map((event) => event.action)).toEqual(["audit.opened", "audit.closed"]);

    // The schedule: next audit = the last audit's open date + interval.
    const status = await manager.agent.get("/api/audits/status");
    expect(status.body.nextAuditAt).toBe("2026-03-01T12:00:00.000Z");
    expect(status.body.lastAuditAt).toBe("2026-01-01T12:00:00.000Z");
    expect(status.body.openAuditId).toBeNull();

    // 02.01 — a cycle count of Alpha between the audits.
    harness.clock.set("2026-02-01T12:00:00.000Z");
    const counted = await manager.agent
      .post("/api/cycle-counts")
      .send({ skuId: sku.id, serial: alpha });
    expect(counted.status).toBe(200);
    expect(counted.body.part.lastCountedAt).toBe("2026-02-01T12:00:00.000Z");

    // 03.01 — the scheduled audit arrives. Since ticket 02 the window opens
    // ITSELF at the boundary: the status poll performs the lazy transition,
    // so the same request that used to show "due" now reports the open
    // window, stamped with the boundary that triggered it, and due-ness
    // computes against 01.01.
    harness.clock.set("2026-03-01T12:00:00.000Z");
    const dueStatus = await manager.agent.get("/api/audits/status");
    expect(dueStatus.body.openAuditId).not.toBeNull();
    expect(dueStatus.body.banner.stage).toBe("open");
    const second = await manager.agent.get(`/api/audits/${dueStatus.body.openAuditId}`);
    expect(second.body.scheduledAt).toBe("2026-03-01T12:00:00.000Z");
    expect(second.body.previousAuditId).toBe(first.body.id);
    // Anchor = end of the previous audit's open day: a count taken during
    // the previous audit (01.01) is due again; a count between audits
    // (Alpha, counted 02.01) is exempt; Charlie is Unavailable, not demanded.
    expect(second.body.anchorAt).toBe("2026-01-01T23:59:59.999Z");
    expect(second.body.parts.due.map((part: PartViewJson) => part.serial)).toEqual([bravo]);
    expect(exemptFor(second.body, alpha)).toBe("recently-counted");
    expect(exemptFor(second.body, charlie)).toBe("unavailable");

    // Count Bravo and close the second audit.
    await manager.agent.post(`/api/audits/${second.body.id}/scan`).send({ serial: bravo });
    const secondClosed = await manager.agent.post(`/api/audits/${second.body.id}/close`).send({});
    expect(secondClosed.body.summary).toEqual({ demanded: 1, counted: 1, failed: 0, moved: 0 });

    // 05.01 — Alpha's 02.01 count now falls on or before the previous audit
    // (03.01): it is due again, exactly as the worked example demands. The
    // third window opened itself from the second's scheduled_at.
    harness.clock.set("2026-05-01T12:00:00.000Z");
    const thirdStatus = await manager.agent.get("/api/audits/status");
    const third = await manager.agent.get(`/api/audits/${thirdStatus.body.openAuditId}`);
    expect(third.body.scheduledAt).toBe("2026-05-01T12:00:00.000Z");
    expect(third.body.anchorAt).toBe("2026-03-01T23:59:59.999Z");
    expect(third.body.parts.due.map((part: PartViewJson) => part.serial)).toEqual([alpha, bravo]);
    expect(exemptFor(third.body, charlie)).toBe("unavailable");

    // The audit list shows all three, newest first, with summaries.
    const list = await manager.agent.get("/api/audits");
    expect(list.status).toBe(200);
    expect(list.body.audits).toHaveLength(3);
    expect(list.body.audits[0].id).toBe(third.body.id);
    expect(list.body.audits[2].summary).toEqual({ demanded: 3, counted: 2, failed: 1, moved: 0 });
  });
});

describe("banner reminders", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness({ now: "2026-01-01T12:00:00.000Z" });
  });
  afterEach(() => harness.close());

  it("appears two weeks and one week before a scheduled audit, and not before", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent);
    const audit = await manager.agent.post("/api/audits").send({});
    await manager.agent.post(`/api/audits/${audit.body.id}/close`).send({});
    // Scheduled next: 2026-03-01T12:00:00.000Z (2-month interval).

    const cases: Array<[string, string | null]> = [
      ["2026-02-14T12:00:00.000Z", null], // 15 days out — too early
      ["2026-02-15T12:00:00.000Z", "two-weeks"], // exactly two weeks
      ["2026-02-21T12:00:00.000Z", "two-weeks"], // still the two-week banner
      ["2026-02-22T12:00:00.000Z", "one-week"], // exactly one week
      ["2026-03-01T11:59:59.999Z", "one-week"],
      // At the boundary itself the lazy transition (ticket 02) auto-opens
      // the window during this very request, so the countdown ends here.
      ["2026-03-01T12:00:00.000Z", "open"],
    ];
    for (const [at, stage] of cases) {
      harness.clock.set(at);
      const status = await manager.agent.get("/api/audits/status");
      expect(status.status).toBe(200);
      expect(status.body.banner.stage).toBe(stage);
      expect(status.body.intervalMonths).toBe(2);
    }
  });

  it("shows the window, not a reminder, while an audit is open", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent);
    await manager.agent.post("/api/audits").send({});
    harness.clock.set("2026-02-01T12:00:00.000Z"); // reminder window, but a window is open
    const status = await manager.agent.get("/api/audits/status");
    expect(status.body.banner.stage).toBe("open");
    expect(status.body.openAuditId).not.toBeNull();
  });

  it("once any audit exists a manual open is refused, and the schedule keeps its anchor", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent);
    const first = await manager.agent.post("/api/audits").send({});
    expect(first.status).toBe(201);
    await manager.agent.post(`/api/audits/${first.body.id}/close`).send({});

    // Ticket 02: from the second window on, opening is automatic — a manual
    // open would re-anchor the cadence on an arbitrary date, so even a
    // manager is refused, and the schedule keeps deriving from scheduled_at.
    harness.clock.set("2026-02-15T12:00:00.000Z");
    const early = await manager.agent.post("/api/audits").send({});
    expect(early.status).toBe(409);
    const status = await manager.agent.get("/api/audits/status");
    // The cadence stays anchored on the first audit; the refused attempt
    // moved nothing.
    expect(status.body.nextAuditAt).toBe("2026-03-01T12:00:00.000Z");
  });
});

describe("exemptions", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness({ now: "2026-01-01T12:00:00.000Z" });
  });
  afterEach(() => harness.close());

  it("in-transit parts are exempt, loose RMA-bin parts are exempt, Unavailable and Damaged by Tech are not demanded, Reserved parts ARE in scope", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [shelf, reserved, gone, rmaBin, rmaLoose, damaged] = await intakeParts(manager.agent, sku.id, 6);

    forceStatus(harness, reserved, "reserved"); // ticket 05's batch reservation owns this path
    await manager.agent
      .post(`/api/parts/${gone}/status`)
      .send({ status: "unavailable", note: "consumed in a repair" });
    await manager.agent.post(`/api/parts/${rmaBin}/status`).send({ status: "rma", note: "DOA screen" });
    await manager.agent.post(`/api/parts/${rmaLoose}/status`).send({ status: "rma", note: "awaiting the next run" });
    await manager.agent
      .post(`/api/parts/${damaged}/status`)
      .send({ status: "damaged_by_tech", note: "cracked during install" });

    // A real in-transit RMA order carrying the RMA-bin part (ticket 09);
    // ticket 29 gives scanned parts the In-Transit status.
    const order = await manager.agent.post("/api/rma-orders").send({ note: "monthly RMA run" });
    expect(order.status).toBe(201);
    const scanned = await manager.agent
      .post(`/api/rma-orders/${order.body.id}/parts`)
      .send({ serial: rmaBin });
    expect(scanned.status).toBe(201);

    const audit = await manager.agent.post("/api/audits").send({});
    expect(audit.status).toBe(201);
    expect(audit.body.parts.due.map((part: PartViewJson) => part.serial).sort()).toEqual(
      [shelf, reserved].sort()
    );
    expect(exemptFor(audit.body, rmaBin)).toBe("in-transit");
    expect(exemptFor(audit.body, rmaLoose)).toBe("rma");
    expect(exemptFor(audit.body, gone)).toBe("unavailable");
    expect(exemptFor(audit.body, damaged)).toBe("damaged_by_tech");

    // Closing does not touch any exempt part.
    const closed = await manager.agent.post(`/api/audits/${audit.body.id}/close`).send({});
    expect(closed.body.parts.failed.map((part: PartViewJson) => part.serial).sort()).toEqual(
      [shelf, reserved].sort()
    );
    expect(partStatus(harness, reserved)).toBe("unavailable");
    expect(partStatus(harness, rmaBin)).toBe("in_transit");
    expect(partStatus(harness, rmaLoose)).toBe("rma");
    expect(partStatus(harness, gone)).toBe("unavailable");
    expect(partStatus(harness, damaged)).toBe("damaged_by_tech");
  });

  it("a part added while the window is open is not demanded and never fails at close", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [original] = await intakeParts(manager.agent, sku.id, 1);
    const audit = await manager.agent.post("/api/audits").send({});
    expect(audit.body.parts.due.map((part: PartViewJson) => part.serial)).toEqual([original]);

    // A part arrives mid-window: never counted, never demanded.
    const [newcomer] = await intakeParts(manager.agent, sku.id, 1);
    harness.clock.set("2026-01-02T12:00:00.000Z");
    const closed = await manager.agent.post(`/api/audits/${audit.body.id}/close`).send({});
    expect(closed.body.parts.failed.map((part: PartViewJson) => part.serial)).toEqual([original]);
    expect(partStatus(harness, newcomer)).toBe("available");
    expect(exemptFor(closed.body, newcomer)).toBe("added-since-open");
  });

  it("a due part accounted for mid-window is moved, not failed", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [part] = await intakeParts(manager.agent, sku.id, 1);
    const audit = await manager.agent.post("/api/audits").send({});

    // A user moves the due part to RMA mid-window, with a note.
    await manager.agent
      .post(`/api/parts/${part}/status`)
      .send({ status: "rma", note: "pulled for return before the audit" });

    const closed = await manager.agent.post(`/api/audits/${audit.body.id}/close`).send({});
    expect(closed.body.parts.failed).toHaveLength(0);
    expect(closed.body.parts.moved.map((p: PartViewJson) => p.serial)).toEqual([part]);
    expect(partStatus(harness, part)).toBe("rma");
  });
});

describe("counting and scan-wins", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness({ now: "2026-01-01T12:00:00.000Z" });
  });
  afterEach(() => harness.close());

  it("a scan of an Unavailable part found on the shelf restores it to Available with a required note", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [found] = await intakeParts(manager.agent, sku.id, 1);
    await manager.agent
      .post(`/api/parts/${found}/status`)
      .send({ status: "unavailable", note: "audit counted it missing" });

    // Physical reality wins — but only with a note.
    const noNote = await manager.agent
      .post("/api/cycle-counts")
      .send({ skuId: sku.id, serial: found });
    expect(noNote.status).toBe(400);
    expect(String(noNote.body.error)).toContain("note");

    harness.clock.set("2026-02-01T12:00:00.000Z");
    const restored = await manager.agent
      .post("/api/cycle-counts")
      .send({ skuId: sku.id, serial: found, note: "it was on the shelf after all" });
    expect(restored.status).toBe(200);
    expect(restored.body.statusChanged).toBe(true);
    expect(restored.body.part.status).toBe("available");
    expect(restored.body.part.lastCountedAt).toBe("2026-02-01T12:00:00.000Z");
    expect(partStatus(harness, found)).toBe("available");

    // Two events: the count, and the status change carrying the note.
    const counted = partEvent(harness, found, "part.counted");
    expect(JSON.parse(counted!.payload)).toMatchObject({
      context: "cycle_count",
      restoredFrom: "unavailable",
    });
    expect(counted!.actor_id).toBe(manager.user.id);
    const changed = partEvent(harness, found, "part.status_changed");
    expect(JSON.parse(changed!.payload)).toMatchObject({
      from: "unavailable",
      to: "available",
      note: "it was on the shelf after all",
    });
  });

  it("scan-wins works inside an audit window too, and the part shows as scanned", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [fresh, lost] = await intakeParts(manager.agent, sku.id, 2);
    const audit = await manager.agent.post("/api/audits").send({});
    await manager.agent.post(`/api/audits/${audit.body.id}/scan`).send({ serial: fresh });
    // Close with `lost` unscanned: it fails and becomes Unavailable.
    await manager.agent.post(`/api/audits/${audit.body.id}/close`).send({});
    expect(partStatus(harness, lost)).toBe("unavailable");

    // A later audit: the lost part is exempt (Unavailable, not demanded) —
    // but a tech finds it and scans it during the window. The second window
    // opens itself at the boundary (ticket 02).
    harness.clock.set("2026-03-01T12:00:00.000Z");
    const secondStatus = await manager.agent.get("/api/audits/status");
    const second = await manager.agent.get(`/api/audits/${secondStatus.body.openAuditId}`);
    const scan = await manager.agent
      .post(`/api/audits/${second.body.id}/scan`)
      .send({ serial: lost, note: "found it in the wrong bin" });
    expect(scan.status).toBe(200);
    expect(scan.body.statusChanged).toBe(true);
    expect(partStatus(harness, lost)).toBe("available");

    const detail = await manager.agent.get(`/api/audits/${second.body.id}`);
    // It was not demanded (exempt at open), but the scan is visible.
    expect(detail.body.parts.due.map((p: PartViewJson) => p.serial)).not.toContain(lost);
    expect(detail.body.parts.scanned.map((p: PartViewJson) => p.serial)).toContain(lost);
    // `fresh` was counted during the first audit (01.01) → due again here.
    expect(detail.body.parts.due.map((p: PartViewJson) => p.serial)).toContain(fresh);
  });

  it("cycle counting any SKU: any user, any time — refreshes last-count dates and validates the SKU", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const screen = await createSku(tech.agent);
    const battery = await createSku(tech.agent, { name: "iPhone 13 Battery", price: "30.00" });
    const adhesive = await createSku(tech.agent, {
      name: "Adhesive strips",
      price: "1.50",
      kind: "consumable",
    });
    const [screenPart] = await intakeParts(tech.agent, screen.id, 1);
    const [batteryPart] = await intakeParts(tech.agent, battery.id, 1);

    // Cycle counting is not restricted to audits or managers.
    const response = await tech.agent
      .post("/api/cycle-counts")
      .send({ skuId: screen.id, serial: screenPart, note: "monthly spot check" });
    expect(response.status).toBe(200);
    expect(response.body.part.lastCountedAt).toBe(harness.clock.now().toISOString());
    expect(response.body.part.skuId).toBe(screen.id);

    // A serial that belongs to another SKU is refused by name.
    const wrongSku = await tech.agent
      .post("/api/cycle-counts")
      .send({ skuId: screen.id, serial: batteryPart });
    expect(wrongSku.status).toBe(400);
    expect(String(wrongSku.body.error)).toContain(batteryPart);

    // Consumables are never cycle-counted.
    const consumable = await tech.agent
      .post("/api/cycle-counts")
      .send({ skuId: adhesive.id, serial: screenPart });
    expect(consumable.status).toBe(400);

    // Unknown serial / SKU.
    expect(
      (await tech.agent.post("/api/cycle-counts").send({ skuId: screen.id, serial: "P99999" })).status
    ).toBe(404);
    expect(
      (await tech.agent.post("/api/cycle-counts").send({ skuId: 9999, serial: screenPart })).status
    ).toBe(404);

    // The count shows on the part's timeline.
    const event = partEvent(harness, screenPart, "part.counted");
    expect(JSON.parse(event!.payload)).toMatchObject({ context: "cycle_count" });
  });
});

describe("audit window mechanics", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness({ now: "2026-01-01T12:00:00.000Z" });
  });
  afterEach(() => harness.close());

  it("requires a session", async () => {
    expect((await harness.request.get("/api/audits/status")).status).toBe(401);
    expect((await harness.request.post("/api/audits").send({})).status).toBe(401);
    expect((await harness.request.post("/api/cycle-counts").send({})).status).toBe(401);
  });

  it("a manager bootstraps the first window; techs scan but cannot open or close; closed windows refuse scans", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(tech.agent);
    const [part] = await intakeParts(tech.agent, sku.id, 1);

    // Ticket 02: opening is manager-only from the very first window.
    const techOpen = await tech.agent.post("/api/audits").send({ note: "quiet week — counting now" });
    expect(techOpen.status).toBe(403);

    const opened = await manager.agent.post("/api/audits").send({});
    expect(opened.status).toBe(201);
    expect(opened.body.openedBy).toMatchObject({ email: MANAGER });

    // ...and one-shot: once any audit exists even the manager is refused —
    // every later window opens itself at its boundary.
    const managerSecond = await manager.agent.post("/api/audits").send({});
    expect(managerSecond.status).toBe(409);
    const techSecond = await tech.agent.post("/api/audits").send({});
    expect(techSecond.status).toBe(403);

    const scan = await tech.agent.post(`/api/audits/${opened.body.id}/scan`).send({ serial: part });
    expect(scan.status).toBe(200);
    expect(scan.body.statusChanged).toBe(false);

    // Ticket 03: closing is manager-gated. The tech's scan stands, but the
    // close decision does not — 403 before any state is touched.
    const techClose = await tech.agent.post(`/api/audits/${opened.body.id}/close`).send({});
    expect(techClose.status).toBe(403);

    const closed = await manager.agent.post(`/api/audits/${opened.body.id}/close`).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.summary).toEqual({ demanded: 1, counted: 1, failed: 0, moved: 0 });
    expect(closed.body.closeKind).toBe("complete");

    // A closed window refuses scans and closes: the tech's second close is
    // stopped by the role gate, not by the closed-window check.
    const lateScan = await tech.agent.post(`/api/audits/${opened.body.id}/scan`).send({ serial: part });
    expect(lateScan.status).toBe(409);
    const lateClose = await tech.agent.post(`/api/audits/${opened.body.id}/close`).send({});
    expect(lateClose.status).toBe(403);

    // Unknown audit / serial. The close gate runs before the lookup, so a
    // tech gets 403 even for a nonexistent audit; a manager gets the 404.
    expect((await tech.agent.get("/api/audits/9999")).status).toBe(404);
    expect((await tech.agent.post("/api/audits/9999/close").send({})).status).toBe(403);
    expect((await manager.agent.post("/api/audits/9999/close").send({})).status).toBe(404);
    const unknownScan = await tech.agent
      .post(`/api/audits/${opened.body.id}/scan`)
      .send({ serial: "P99999" });
    expect(unknownScan.status).toBe(404);
  });

  it("honors a manager-changed audit interval", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent);
    const patched = await manager.agent
      .patch("/api/settings")
      .send({ key: "audit_interval_months", value: 1 });
    expect(patched.status).toBe(200);

    const audit = await manager.agent.post("/api/audits").send({});
    await manager.agent.post(`/api/audits/${audit.body.id}/close`).send({});
    const status = await manager.agent.get("/api/audits/status");
    expect(status.body.intervalMonths).toBe(1);
    expect(status.body.nextAuditAt).toBe("2026-02-01T12:00:00.000Z");
  });

  it("shows banner state even with no audits yet (no schedule until the first audit)", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent);
    const status = await manager.agent.get("/api/audits/status");
    expect(status.body.lastAuditAt).toBeNull();
    expect(status.body.nextAuditAt).toBeNull();
    expect(status.body.banner.stage).toBeNull();
    expect(status.body.openAuditId).toBeNull();
  });
});

/**
 * Ticket 14, hole 2: audit close fails a Reserved part to Unavailable, and
 * the part's batch attachment must be settled explicitly in the same
 * transaction — otherwise the next swap on that attachment dies with the
 * misleading "claimed by another request" race message.
 */
describe("audit close settles a Reserved part's batch attachment (ticket 14, hole 2)", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness({ now: "2026-01-01T12:00:00.000Z" });
  });
  afterEach(() => harness.close());

  it("closing fails a Reserved part, ends its attachment with a settlement event, and the next swap reports the removal clearly", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [serial] = await intakeParts(manager.agent, sku.id, 1);

    // A real reservation through the batch-parts seam (not forceStatus).
    const batch = await manager.agent.post("/api/batches").send({ note: "audit settlement batch" });
    expect(batch.status).toBe(201);
    const batchId = batch.body.id as number;
    const device = await manager.agent.post(`/api/batches/${batchId}/devices`).send({
      modelName: "iPhone 13",
      statedIssue: "Cracked screen",
      imei: "359175920074058",
    });
    expect(device.status).toBe(201);
    const deviceId = device.body.id as number;
    const added = await manager.agent
      .post(`/api/batches/${batchId}/devices/${deviceId}/parts`)
      .send({ skuId: sku.id });
    expect(added.status).toBe(201);
    expect(added.body.outcome).toBe("reserved");
    const attachmentId = added.body.attachment.id as number;
    expect(partStatus(harness, serial)).toBe("reserved");

    // The audit demands the Reserved part; nobody scans it; close fails it.
    const audit = await manager.agent.post("/api/audits").send({});
    expect(audit.status).toBe(201);
    expect(audit.body.parts.due.map((part: PartViewJson) => part.serial)).toEqual([serial]);

    const closed = await manager.agent.post(`/api/audits/${audit.body.id}/close`).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.parts.failed.map((part: PartViewJson) => part.serial)).toEqual([serial]);
    expect(partStatus(harness, serial)).toBe("unavailable");

    // The attachment was settled explicitly — not left dangling.
    const attachment = harness.db
      .prepare(
        "SELECT removed_at, removed_to, removal_reason, removal_note FROM device_parts WHERE id = ?"
      )
      .get(attachmentId) as {
      removed_at: string | null;
      removed_to: string;
      removal_reason: string;
      removal_note: string;
    };
    expect(attachment.removed_at).not.toBeNull();
    expect(attachment.removed_to).toBe("unavailable");
    expect(attachment.removal_reason).toBe("audit");
    expect(attachment.removal_note).toContain(`audit #${audit.body.id}`);

    // The device's timeline records the settlement.
    const settled = harness.db
      .prepare(
        "SELECT payload FROM events WHERE entity_type = 'device' AND entity_id = ? AND action = 'device.part_settled'"
      )
      .get(deviceId) as { payload: string };
    expect(JSON.parse(settled.payload)).toMatchObject({
      attachmentId,
      serial,
      auditId: audit.body.id,
      reason: "audit_failed",
    });

    // And the next swap no longer fails with the misleading race message —
    // the attachment is simply gone.
    const swap = await manager.agent
      .post(`/api/batches/${batchId}/devices/${deviceId}/parts/${attachmentId}/swap`)
      .send({ destination: "available", note: "replacement" });
    expect(swap.status).toBe(409);
    expect(String(swap.body.error)).toContain("already removed");
  });
});

/**
 * Ticket 01, the schedule-anchor swap (spec decisions 3 + 11, ADR-0002): the
 * cadence derives from the last audit's `scheduled_at` — the boundary that
 * triggered it — instead of its `opened_at`, so a lazy open after its
 * boundary cannot drift the schedule. Zero observable behavior change: the
 * backfill makes the historical anchors identical, and transitional manual
 * opens still re-anchor on their own dates until ticket 02 lands.
 */
describe("the scheduled_at backfill (migration 0025, ticket 01)", () => {
  it("backfills scheduled_at = opened_at for every existing audit row, and the derived next boundary is bit-identical to the pre-swap opened_at anchor", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "audit-backfill-test-"));
    const db = openDatabase(path.join(dir, "backfill.sqlite"));
    try {
      const clock = new FakeClock("2026-06-01T12:00:00.000Z");
      // Full schema at head; 0025 runs as a no-op on the empty audits table.
      migrate(db, clock);

      // Rebuild the PRE-swap world: drop 0025 from the ledger so the runner
      // re-applies exactly that file, and insert audits shaped as they
      // existed before the swap — a first audit with no boundary
      // (scheduled_at NULL) and a scheduled one whose lazy open (03.05) lags
      // its boundary (03.01).
      db.prepare("DELETE FROM migrations WHERE name = ?").run(
        "0025-audit-scheduled-at-backfill.sql"
      );
      db.prepare(
        "INSERT INTO users (email, role, active, created_at) VALUES ('counter@acme.co', 'tech', 1, ?)"
      ).run(clock.now().toISOString());
      const insertAudit = db.prepare(
        "INSERT INTO audits (scheduled_at, opened_at, opened_by, closed_at, closed_by, previous_audit_id, anchor_at) VALUES (?, ?, 1, ?, 1, ?, ?)"
      );
      insertAudit.run(null, "2026-01-01T12:00:00.000Z", "2026-01-20T12:00:00.000Z", null, null);
      insertAudit.run(
        "2026-03-01T12:00:00.000Z",
        "2026-03-05T09:30:00.000Z",
        "2026-03-20T12:00:00.000Z",
        1,
        "2026-01-01T23:59:59.999Z"
      );

      // BEFORE the swap the cadence anchored on the last audit's opened_at;
      // that is the boundary the backfilled history must reproduce exactly.
      const beforeSwap = addMonthsUTC(new Date("2026-03-05T09:30:00.000Z"), 2);

      migrate(db, clock); // re-applies exactly 0025 against the pre-swap rows

      const rows = db
        .prepare("SELECT scheduled_at, opened_at FROM audits ORDER BY id")
        .all() as Array<{ scheduled_at: string | null; opened_at: string }>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.scheduled_at).toBe(row.opened_at);
      }

      // The swapped schedule reads the backfilled scheduled_at and lands on
      // exactly the boundary the opened_at anchor produced before it.
      const schedule = auditSchedule(db);
      expect(schedule.lastScheduledAt?.toISOString()).toBe("2026-03-05T09:30:00.000Z");
      expect(schedule.nextAuditAt?.toISOString()).toBe(beforeSwap.toISOString());
      expect(schedule.nextAuditAt?.toISOString()).toBe("2026-05-05T09:30:00.000Z");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The schedule anchor (ticket 01, landed; ticket 02 closes the loop): the
 * cadence derives from the last audit's `scheduled_at`, and since ticket 02
 * the only manual open is the bootstrap — so the anchor can never be moved
 * by a hand-opened window again.
 */
describe("schedule anchoring on scheduled_at (ticket 01, enforced by ticket 02)", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness({ now: "2026-01-01T12:00:00.000Z" });
  });
  afterEach(() => harness.close());

  it("an early manual open is refused, so the cadence can never re-anchor on an actual open moment", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent);
    const first = await manager.agent.post("/api/audits").send({});
    await manager.agent.post(`/api/audits/${first.body.id}/close`).send({});

    // Under ticket 01 a manual early open re-anchored the cadence on its
    // own date (the transitional rule). Ticket 02 removes manual opens:
    // the refusal is what makes the drift-free anchor permanent.
    harness.clock.set("2026-02-15T12:00:00.000Z");
    const early = await manager.agent.post("/api/audits").send({});
    expect(early.status).toBe(409);

    const status = await manager.agent.get("/api/audits/status");
    expect(status.body.lastAuditAt).toBe("2026-01-01T12:00:00.000Z");
    expect(status.body.lastScheduledAt).toBeNull();
    // Still anchored on the bootstrap audit's own open date.
    expect(status.body.nextAuditAt).toBe("2026-03-01T12:00:00.000Z");
  });

  it("a boundary auto-open stamps the boundary, and the cadence derives from scheduled_at, not the actual open moment", async () => {
    const manager = await harness.loginAs(MANAGER);
    await createSku(manager.agent);
    const first = await manager.agent.post("/api/audits").send({});
    await manager.agent.post(`/api/audits/${first.body.id}/close`).send({});

    // One day PAST the 03.01 boundary, the first request (the status poll)
    // auto-opens the window. The window is stamped with the boundary that
    // triggered it, and the next boundary derives from that stamp, not from
    // the actual open moment (which would have drifted the schedule to
    // 05.02 under the old opened_at anchor).
    harness.clock.set("2026-03-02T12:00:00.000Z");
    const status = await manager.agent.get("/api/audits/status");
    const second = await manager.agent.get(`/api/audits/${status.body.openAuditId}`);
    expect(second.body.scheduledAt).toBe("2026-03-01T12:00:00.000Z");

    const after = await manager.agent.get("/api/audits/status");
    expect(after.body.lastAuditAt).toBe("2026-03-02T12:00:00.000Z");
    expect(after.body.lastScheduledAt).toBe("2026-03-01T12:00:00.000Z");
    expect(after.body.nextAuditAt).toBe("2026-05-01T12:00:00.000Z");
  });
});

/**
 * Ticket 02 — the automatic window lifecycle (ADR-0002): lazy boundary
 * processing on any authenticated audits-domain request (no background
 * jobs), auto-close with the unchanged no-grace settlement, the computed
 * close kind, auto-open from the boundary, the collapse rule for multiple
 * missed boundaries, and the bootstrap-only manual open.
 */
describe("automatic window lifecycle (ticket 02)", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness({ now: "2026-01-01T12:00:00.000Z" });
  });
  afterEach(() => harness.close());

  it("past a boundary, a status request auto-closes the open window (closed_by NULL, system event) and auto-opens the next from that boundary", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [alpha, bravo] = await intakeParts(manager.agent, sku.id, 2);

    // Bootstrap the first window — no boundary triggered it, scheduled_at NULL.
    const first = await manager.agent.post("/api/audits").send({});
    expect(first.status).toBe(201);
    expect(first.body.scheduledAt).toBeNull();
    await manager.agent.post(`/api/audits/${first.body.id}/scan`).send({ serial: alpha });

    // The 03.01 boundary passes in silence; the next status poll settles it.
    harness.clock.set("2026-03-02T09:00:00.000Z");
    const status = await manager.agent.get("/api/audits/status");
    expect(status.body.openAuditId).not.toBe(first.body.id);
    expect(status.body.banner.stage).toBe("open");
    const newId = status.body.openAuditId as number;

    // The old window: auto-closed — closed_by NULL, the kind computed from
    // the buckets (bravo was due and unscanned → shortfall), settlement ran.
    const closedOld = await manager.agent.get(`/api/audits/${first.body.id}`);
    expect(closedOld.body.open).toBe(false);
    expect(closedOld.body.closedAt).toBe("2026-03-02T09:00:00.000Z");
    expect(closedOld.body.closedBy).toBeNull();
    expect(closedOld.body.closeKind).toBe("shortfall");
    expect(closedOld.body.summary).toEqual({ demanded: 2, counted: 1, failed: 1, moved: 0 });
    expect(partStatus(harness, bravo)).toBe("unavailable");

    // The audit's own timeline records the auto-close as a SYSTEM event.
    const autoEvent = harness.db
      .prepare(
        "SELECT actor_id, payload FROM events WHERE entity_type = 'audit' AND entity_id = ? AND action = 'audit.closed'"
      )
      .get(first.body.id) as { actor_id: number | null; payload: string };
    expect(autoEvent.actor_id).toBeNull();
    expect(JSON.parse(autoEvent.payload)).toMatchObject({
      auto: true,
      reason: "interval",
      boundary: "2026-03-01T12:00:00.000Z",
      missedBoundaryCount: 1,
      closeKind: "shortfall",
    });

    // The new window: opened from the boundary, not the request moment;
    // opened_at is the factual lazy-open instant.
    const opened = await manager.agent.get(`/api/audits/${newId}`);
    expect(opened.body.open).toBe(true);
    expect(opened.body.scheduledAt).toBe("2026-03-01T12:00:00.000Z");
    expect(opened.body.openedAt).toBe("2026-03-02T09:00:00.000Z");
    expect(opened.body.previousAuditId).toBe(first.body.id);
    // The due-ness anchor is unchanged: end of the previous audit's open DAY.
    expect(opened.body.anchorAt).toBe("2026-01-01T23:59:59.999Z");
    // Bravo failed out (Unavailable, exempt); alpha counted 01.01 → due again.
    expect(opened.body.parts.due.map((p: PartViewJson) => p.serial)).toEqual([alpha]);
    expect(exemptFor(opened.body, bravo)).toBe("unavailable");

    // Exactly one open window — and the schedule continued from the boundary.
    expect((await manager.agent.post("/api/audits").send({})).status).toBe(409);
    expect(status.body.nextAuditAt).toBe("2026-05-01T12:00:00.000Z");
  });

  it("an auto-close with nothing left due records complete", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [alpha] = await intakeParts(manager.agent, sku.id, 1);
    const first = await manager.agent.post("/api/audits").send({});
    await manager.agent.post(`/api/audits/${first.body.id}/scan`).send({ serial: alpha });

    harness.clock.set("2026-03-02T09:00:00.000Z");
    const status = await manager.agent.get("/api/audits/status");
    const closedOld = await manager.agent.get(`/api/audits/${first.body.id}`);
    expect(closedOld.body.closeKind).toBe("complete");
    expect(closedOld.body.closedBy).toBeNull();
    expect(closedOld.body.summary).toEqual({ demanded: 1, counted: 1, failed: 0, moved: 0 });
    expect(partStatus(harness, alpha)).toBe("available");
    expect(status.body.openAuditId).not.toBeNull();
  });

  it("the lazy transition runs on any audits-domain request, not only the status poll", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [alpha] = await intakeParts(manager.agent, sku.id, 1);
    const first = await manager.agent.post("/api/audits").send({});

    harness.clock.set("2026-03-02T09:00:00.000Z");
    // A scan aimed at the old window meets the transition first: the window
    // was auto-closed under this very request.
    const scan = await manager.agent.post(`/api/audits/${first.body.id}/scan`).send({ serial: alpha });
    expect(scan.status).toBe(409);

    const status = await manager.agent.get("/api/audits/status");
    expect(status.body.openAuditId).not.toBeNull();
    expect(status.body.openAuditId).not.toBe(first.body.id);
  });

  it("two missed boundaries collapse: one settlement, one new window, no phantom audits", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [alpha, bravo] = await intakeParts(manager.agent, sku.id, 2);
    const first = await manager.agent.post("/api/audits").send({});
    await manager.agent.post(`/api/audits/${first.body.id}/scan`).send({ serial: alpha });

    // Both boundaries (03.01 and 05.01) pass in silence with the window open.
    harness.clock.set("2026-05-02T09:00:00.000Z");
    const status = await manager.agent.get("/api/audits/status");
    const newId = status.body.openAuditId as number;
    expect(newId).not.toBe(first.body.id);

    // Exactly ONE settlement: a single audit.closed event on the old window,
    // recording the boundary it fired at and the gap it covers.
    const events = harness.db
      .prepare(
        "SELECT actor_id, payload FROM events WHERE entity_type = 'audit' AND entity_id = ? AND action = 'audit.closed'"
      )
      .all(first.body.id) as Array<{ actor_id: number | null; payload: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].actor_id).toBeNull();
    expect(JSON.parse(events[0].payload)).toMatchObject({
      auto: true,
      boundary: "2026-05-01T12:00:00.000Z",
      missedBoundaryCount: 2,
    });

    // One new window, opened from the LATEST missed boundary; no phantom
    // audit exists for 03.01. The schedule continues from the latest
    // boundary, not the first missed one.
    const list = await manager.agent.get("/api/audits");
    expect(list.body.audits).toHaveLength(2);
    const opened = await manager.agent.get(`/api/audits/${newId}`);
    expect(opened.body.scheduledAt).toBe("2026-05-01T12:00:00.000Z");
    expect(opened.body.previousAuditId).toBe(first.body.id);
    expect(opened.body.anchorAt).toBe("2026-01-01T23:59:59.999Z");
    expect(status.body.nextAuditAt).toBe("2026-07-01T12:00:00.000Z");

    // The single settlement settled bravo exactly once.
    const oldDetail = await manager.agent.get(`/api/audits/${first.body.id}`);
    expect(oldDetail.body.summary).toEqual({ demanded: 2, counted: 1, failed: 1, moved: 0 });
    expect(partStatus(harness, bravo)).toBe("unavailable");
  });

  it("an early close leaves a quiet gap: the next window opens on schedule, not on close", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [alpha] = await intakeParts(manager.agent, sku.id, 1);
    const first = await manager.agent.post("/api/audits").send({});
    await manager.agent.post(`/api/audits/${first.body.id}/scan`).send({ serial: alpha });
    await manager.agent.post(`/api/audits/${first.body.id}/close`).send({});

    // Mid-gap (02.15): no window, the banner counts down, and the
    // audits-domain request performs no transition — still exactly one audit.
    harness.clock.set("2026-02-15T12:00:00.000Z");
    let status = await manager.agent.get("/api/audits/status");
    expect(status.body.openAuditId).toBeNull();
    expect(status.body.banner.stage).toBe("two-weeks");
    let list = await manager.agent.get("/api/audits");
    expect(list.body.audits).toHaveLength(1);

    // Past the 03.01 boundary: the next request opens the window.
    harness.clock.set("2026-03-02T12:00:00.000Z");
    status = await manager.agent.get("/api/audits/status");
    expect(status.body.openAuditId).not.toBeNull();
    const opened = await manager.agent.get(`/api/audits/${status.body.openAuditId}`);
    expect(opened.body.scheduledAt).toBe("2026-03-01T12:00:00.000Z");
    expect(opened.body.previousAuditId).toBe(first.body.id);

    // The early close stays stamped with the manager who made it.
    const oldDetail = await manager.agent.get(`/api/audits/${first.body.id}`);
    expect(oldDetail.body.closedBy).toMatchObject({ email: MANAGER });
    expect(oldDetail.body.closeKind).toBe("complete");
    list = await manager.agent.get("/api/audits");
    expect(list.body.audits).toHaveLength(2);
  });

  it("a manager's early close computes the kind from the buckets — shortfall even when believed clean, complete when nothing is left; no note required", async () => {
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [alpha, bravo] = await intakeParts(manager.agent, sku.id, 2);
    const first = await manager.agent.post("/api/audits").send({});
    await manager.agent.post(`/api/audits/${first.body.id}/scan`).send({ serial: alpha });

    // Close with bravo unscanned and NO note — the buckets are the evidence,
    // and the shortfall is recorded whatever the closer believed.
    const closed = await manager.agent.post(`/api/audits/${first.body.id}/close`).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.closeKind).toBe("shortfall");
    expect(closed.body.closedBy).toMatchObject({ email: MANAGER });
    expect(partStatus(harness, bravo)).toBe("unavailable");

    // The next window (auto-opened at the boundary), fully scanned → complete.
    harness.clock.set("2026-03-02T09:00:00.000Z");
    const status = await manager.agent.get("/api/audits/status");
    const secondId = status.body.openAuditId as number;
    await manager.agent.post(`/api/audits/${secondId}/scan`).send({ serial: alpha });
    const closed2 = await manager.agent.post(`/api/audits/${secondId}/close`).send({});
    expect(closed2.body.closeKind).toBe("complete");
    expect(closed2.body.summary).toEqual({ demanded: 1, counted: 1, failed: 0, moved: 0 });
  });

  it("bootstrap-only open: 403 for a tech even on a virgin system, 409 for a manager once any audit exists", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const manager = await harness.loginAs(MANAGER);

    // Virgin system: a tech is refused by role, a manager may bootstrap.
    const techOpen = await tech.agent.post("/api/audits").send({});
    expect(techOpen.status).toBe(403);
    const bootstrap = await manager.agent.post("/api/audits").send({ note: "first count" });
    expect(bootstrap.status).toBe(201);
    expect(bootstrap.body.scheduledAt).toBeNull();

    // From the second window on: refused for everyone — opening is
    // automatic, and the refusal protects the schedule's anchor.
    expect((await manager.agent.post("/api/audits").send({})).status).toBe(409);
    expect((await tech.agent.post("/api/audits").send({})).status).toBe(403);

    await manager.agent.post(`/api/audits/${bootstrap.body.id}/close`).send({});
    expect((await manager.agent.post("/api/audits").send({})).status).toBe(409);
  });
});

/**
 * Ticket 03 — the manager-gated close (spec decision 6): closing is the
 * manager's judgment call (accept the shortfall, or certify the count
 * complete), so the close route sits behind `requireManager` — the ONE
 * manager-powers predicate, which an admin passes too. Scanning into the
 * window and reading status stay open to any authenticated user: a tech
 * must be able to work the window without a manager standing by. The lazy
 * boundary processor is not a route and is unaffected — it auto-closes
 * regardless of who triggers the request.
 */
describe("manager-gated close (ticket 03)", () => {
  let harness: TestHarness;
  beforeEach(() => {
    harness = createTestHarness({ now: "2026-01-01T12:00:00.000Z" });
  });
  afterEach(() => harness.close());

  it("a tech gets 403 closing an open window; the window is untouched and stays open", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [part] = await intakeParts(manager.agent, sku.id, 1);
    const audit = await manager.agent.post("/api/audits").send({});
    expect(audit.status).toBe(201);

    const denied = await tech.agent.post(`/api/audits/${audit.body.id}/close`).send({});
    expect(denied.status).toBe(403);

    // The refusal touched nothing: the window is still open and its part
    // still due — the gate runs before any settlement.
    const after = await tech.agent.get(`/api/audits/${audit.body.id}`);
    expect(after.body.open).toBe(true);
    expect(after.body.parts.due.map((p: PartViewJson) => p.serial)).toEqual([part]);
    expect((await manager.agent.get("/api/audits/status")).body.openAuditId).toBe(audit.body.id);
  });

  it("a manager and an admin both close normally — through the same manager-powers predicate", async () => {
    const admin = await harness.createUserAs("admin@acme.co", "admin");
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [alpha, bravo] = await intakeParts(manager.agent, sku.id, 2);

    const first = await manager.agent.post("/api/audits").send({});
    await manager.agent.post(`/api/audits/${first.body.id}/scan`).send({ serial: alpha });
    // The ADMIN closes the window: unchanged behavior — computed kind from
    // the buckets (bravo unscanned → shortfall), no note required, the
    // closer stamped `closed_by`.
    const adminClosed = await admin.agent.post(`/api/audits/${first.body.id}/close`).send({});
    expect(adminClosed.status).toBe(200);
    expect(adminClosed.body.closeKind).toBe("shortfall");
    expect(adminClosed.body.closedBy).toMatchObject({ email: "admin@acme.co" });
    expect(partStatus(harness, bravo)).toBe("unavailable");

    // The manager closes the next (auto-opened) window the same way.
    harness.clock.set("2026-03-02T09:00:00.000Z");
    const status = await manager.agent.get("/api/audits/status");
    const secondId = status.body.openAuditId as number;
    const managerClosed = await manager.agent
      .post(`/api/audits/${secondId}/close`)
      .send({ note: "count done" });
    expect(managerClosed.status).toBe(200);
    expect(managerClosed.body.closedBy).toMatchObject({ email: MANAGER });
  });

  it("scanning into the window and reading its status stay open to a tech", async () => {
    const tech = await harness.createUserAs("tech@acme.co", "tech");
    const manager = await harness.loginAs(MANAGER);
    const sku = await createSku(manager.agent);
    const [part] = await intakeParts(manager.agent, sku.id, 1);
    const audit = await manager.agent.post("/api/audits").send({});
    expect(audit.status).toBe(201);

    // The status poll (the banner's 60-second trigger) and the detail read.
    const status = await tech.agent.get("/api/audits/status");
    expect(status.status).toBe(200);
    expect(status.body.openAuditId).toBe(audit.body.id);
    const detail = await tech.agent.get(`/api/audits/${audit.body.id}`);
    expect(detail.status).toBe(200);

    // The tech scans the due part — then still cannot close.
    const scan = await tech.agent.post(`/api/audits/${audit.body.id}/scan`).send({ serial: part });
    expect(scan.status).toBe(200);
    expect((await tech.agent.post(`/api/audits/${audit.body.id}/close`).send({})).status).toBe(403);

    // The tech's scan did the work: the MANAGER's close is complete.
    const closed = await manager.agent.post(`/api/audits/${audit.body.id}/close`).send({});
    expect(closed.status).toBe(200);
    expect(closed.body.closeKind).toBe("complete");
    expect(closed.body.summary).toEqual({ demanded: 1, counted: 1, failed: 0, moved: 0 });
  });
});

/**
 * Ticket 02's backfill: every already-closed audit gets its close_kind
 * computed from its own outcome buckets (any `failed` row → shortfall), and
 * an open window keeps NULL until the close core stamps it.
 */
describe("the close_kind backfill (migration 0026, ticket 02)", () => {
  it("backfills close_kind from the outcome buckets for closed audits and leaves open windows NULL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "audit-close-kind-test-"));
    const db = openDatabase(path.join(dir, "close-kind.sqlite"));
    try {
      const clock = new FakeClock("2026-06-01T12:00:00.000Z");
      migrate(db, clock);

      // Rebuild the pre-0026 world: the first migrate already applied 0026,
      // so remove BOTH its ledger row and the column it added — the rows
      // inserted below are then shaped exactly as they existed before 0026.
      db.prepare("DELETE FROM migrations WHERE name = ?").run("0026-audit-close-kind.sql");
      db.exec("ALTER TABLE audits DROP COLUMN close_kind");
      db.prepare(
        "INSERT INTO users (email, role, active, created_at) VALUES ('counter@acme.co', 'tech', 1, ?)"
      ).run(clock.now().toISOString());
      const skuId = Number(
        db
          .prepare(
            "INSERT INTO skus (name, price_cents, kind, buybackable, created_at, price_updated_at) VALUES ('Screen', 1000, 'serialized', 0, ?, ?)"
          )
          .run(clock.now().toISOString(), clock.now().toISOString()).lastInsertRowid
      );
      const insertPart = db.prepare(
        "INSERT INTO serialized_parts (sku_id, serial, status, last_counted_at, created_at) VALUES (?, ?, 'unavailable', NULL, ?)"
      );
      const partA = Number(insertPart.run(skuId, "P00001", clock.now().toISOString()).lastInsertRowid);
      const partB = Number(insertPart.run(skuId, "P00002", clock.now().toISOString()).lastInsertRowid);
      const insertAudit = db.prepare(
        "INSERT INTO audits (scheduled_at, opened_at, opened_by, closed_at, closed_by, previous_audit_id, anchor_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      const complete = insertAudit.run(
        null,
        "2026-01-01T12:00:00.000Z",
        1,
        "2026-01-20T12:00:00.000Z",
        1,
        null,
        null
      );
      const shortfall = insertAudit.run(
        "2026-03-01T12:00:00.000Z",
        "2026-03-05T09:30:00.000Z",
        1,
        "2026-03-20T12:00:00.000Z",
        1,
        1,
        "2026-01-01T23:59:59.999Z"
      );
      const open = insertAudit.run(
        "2026-05-01T12:00:00.000Z",
        "2026-05-05T09:30:00.000Z",
        1,
        null,
        null,
        2,
        "2026-03-05T23:59:59.999Z"
      );
      const insertOutcome = db.prepare(
        "INSERT INTO audit_parts (audit_id, part_id, outcome) VALUES (?, ?, ?)"
      );
      insertOutcome.run(complete.lastInsertRowid, partA, "counted");
      insertOutcome.run(complete.lastInsertRowid, partB, "counted");
      insertOutcome.run(shortfall.lastInsertRowid, partA, "counted");
      insertOutcome.run(shortfall.lastInsertRowid, partB, "failed");
      insertOutcome.run(open.lastInsertRowid, partA, null);

      migrate(db, clock); // re-applies exactly 0026 against those rows

      const rows = db
        .prepare("SELECT id, closed_at, close_kind FROM audits ORDER BY id")
        .all() as Array<{ id: number; closed_at: string | null; close_kind: string | null }>;
      expect(rows).toHaveLength(3);
      expect(rows[0].close_kind).toBe("complete"); // nothing failed
      expect(rows[1].close_kind).toBe("shortfall"); // one failed row
      expect(rows[2].closed_at).toBeNull();
      expect(rows[2].close_kind).toBeNull(); // still open — stamped at close
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
