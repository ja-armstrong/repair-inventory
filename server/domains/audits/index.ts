import { Router } from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { AppContext, Domain } from "../../domain.js";
import { getApiRouter } from "../auth/index.js";
import { requireManager } from "../auth/session.js";
import { timelineFor } from "../auth/timeline.js";
import { normalizeSerial } from "../parts/serials.js";
import {
  applyCount,
  exemptionReason,
  getPartBySerial,
  getSkuKind,
  scanDisagreesWithStatus,
  serializePartView,
  type CountablePartRow,
} from "./counting.js";
import { auditSchedule, bannerStage } from "./schedule.js";
import {
  AUDIT_SELECT,
  closeAuditWindow,
  getAuditRow,
  openAuditId,
  openAuditWindow,
  processDueBoundaries,
  snapshotRows,
  type AuditRow,
  type SnapshotRow,
} from "./lifecycle.js";

/**
 * The audits domain (ticket 10): the counting discipline.
 *
 * Audits are windows: one opens (automatically on the audit_interval_months
 * boundary since ticket 02 — the only manual open left is the manager's
 * one-time bootstrap of the very first window), techs scan (type) serials
 * while it is open, each scan refreshing the part's last-count date, and
 * closing settles with no grace — due-but-unscanned parts become
 * Unavailable, the shrink signal. Due-ness is the spec's rule, verbatim: an
 * audit demands exactly the serialized parts whose last count falls on or
 * before the previous audit. Cycle counting (any user, any time, any SKU)
 * refreshes last-count dates through the same scan path, and the physical
 * scan wins over a disagreeing recorded status (required note).
 *
 * The window lifecycle itself (ticket 02, ADR-0002) lives in
 * `audits/lifecycle.ts` — the one writer of `audits` rows and outcomes,
 * shared by these routes and the lazy boundary processor that runs before
 * every authenticated audits-domain request.
 *
 * Timeline actions: `audit.opened`, `audit.closed` (actor-less when the
 * boundary closed it), `part.counted`, and `part.status_changed`
 * (scan-wins restorations and no-grace failures, both note-carrying — the
 * failure note names the audit).
 */

const NOTE_REQUIRED_FOR_DISAGREEMENT =
  "a note is required: the recorded status says this part is not on the shelf — the scan wins, but the reason is required";

const openSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

const scanSchema = z.object({
  serial: z.string().trim().min(1),
  note: z.string().trim().max(2000).optional(),
});

const cycleCountSchema = z.object({
  skuId: z.number().int().positive(),
  serial: z.string().trim().min(1),
  note: z.string().trim().max(2000).optional(),
});

/**
 * A snapshot row's live state. Post-close the outcome column is stamped and
 * speaks for itself; while the window is open, a scanned part (last count
 * at or after the open instant) counts, a part moved out of circulation
 * mid-window was accounted for, and everything else is still due.
 */
function classifySnapshot(row: SnapshotRow, openedAt: string): "due" | "counted" | "failed" | "moved" {
  if (row.outcome === "failed") {
    return "failed";
  }
  if (row.outcome === "counted") {
    return "counted";
  }
  if (row.outcome === "moved") {
    return "moved";
  }
  if (row.last_counted_at !== null && row.last_counted_at >= openedAt) {
    return "counted";
  }
  if (row.status !== "available" && row.status !== "reserved") {
    return "moved";
  }
  return "due";
}

function summarize(db: Database.Database, audit: AuditRow): {
  demanded: number;
  counted: number;
  failed: number;
  moved: number;
} {
  const counts = { demanded: 0, counted: 0, failed: 0, moved: 0 };
  for (const row of snapshotRows(db, audit.id)) {
    counts.demanded += 1;
    // "due" (still pending in an open window) is not one of the settled
    // summary keys — it is the worklist, surfaced as parts.due instead.
    const state = classifySnapshot(row, audit.opened_at);
    if (state !== "due") {
      counts[state] += 1;
    }
  }
  return counts;
}

/** Parts NOT in the snapshot — the exempt, with reasons, plus anything scanned outside the demand list. */
function nonSnapshotParts(db: Database.Database, auditId: number, openedAt: string): {
  exempt: Array<ReturnType<typeof serializePartView> & { reason: string }>;
  scanned: Array<ReturnType<typeof serializePartView>>;
} {
  const rows = db
    .prepare(
      `SELECT p.id, p.serial, p.status, p.last_counted_at, p.created_at, p.sku_id, s.name AS sku_name
         FROM serialized_parts p JOIN skus s ON s.id = p.sku_id
        WHERE p.id NOT IN (SELECT part_id FROM audit_parts WHERE audit_id = ?)
        ORDER BY p.id`
    )
    .all(auditId) as CountablePartRow[];
  const exempt: Array<ReturnType<typeof serializePartView> & { reason: string }> = [];
  const scanned: Array<ReturnType<typeof serializePartView>> = [];
  for (const row of rows) {
    const reason =
      exemptionReason(db, row) ??
      (row.created_at >= openedAt ? "added-since-open" : "recently-counted");
    exempt.push({ ...serializePartView(row), reason });
    if (row.last_counted_at !== null && row.last_counted_at >= openedAt) {
      scanned.push(serializePartView(row));
    }
  }
  return { exempt, scanned };
}

function serializeAuditDetail(db: Database.Database, audit: AuditRow): Record<string, unknown> {
  const rows = snapshotRows(db, audit.id);
  const buckets: Record<"due" | "counted" | "failed" | "moved", Array<ReturnType<typeof serializePartView>>> = {
    due: [],
    counted: [],
    failed: [],
    moved: [],
  };
  for (const row of rows) {
    buckets[classifySnapshot(row, audit.opened_at)].push(serializePartView(row));
  }
  const { exempt, scanned } = nonSnapshotParts(db, audit.id, audit.opened_at);
  return {
    id: audit.id,
    scheduledAt: audit.scheduled_at,
    openedAt: audit.opened_at,
    closedAt: audit.closed_at,
    openedBy: { id: audit.opened_by, email: audit.opened_by_email },
    closedBy:
      audit.closed_by === null ? null : { id: audit.closed_by, email: audit.closed_by_email },
    closeKind: audit.close_kind,
    previousAuditId: audit.previous_audit_id,
    anchorAt: audit.anchor_at,
    intervalMonths: auditSchedule(db).intervalMonths,
    open: audit.closed_at === null,
    summary: summarize(db, audit),
    parts: {
      due: buckets.due,
      counted: buckets.counted,
      scanned,
      failed: buckets.failed,
      moved: buckets.moved,
      exempt,
    },
    events: timelineFor(db, "audit", audit.id),
  };
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

// `string | string[]`: with a middleware (requireManager) ahead of the
// handler, Express loses the path-typed params — same widening as
// parsePoId in the purchaseorders domain.
function parseId(raw: string | string[] | undefined): number | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export const auditsDomain: Domain = {
  name: "audits",
  register(app: Express, ctx: AppContext): void {
    const api = getApiRouter(app);
    const audits = Router();

    // The lazy boundary processor (ticket 02, ADR-0002). No background jobs:
    // every authenticated audits-domain request — the banner's 60-second
    // status poll above all — settles a window whose boundary has passed
    // and opens the next one BEFORE the route itself runs, so no route ever
    // sees a stale lifecycle. The session gate has already run (every route
    // here sits on the auth domain's gated /api router), so the request's
    // user is available to attribute the writes the transition performs.
    function processBoundaryThen(req: Request, _res: Response, next: NextFunction): void {
      processDueBoundaries(ctx.db, ctx.clock, req.currentUser!);
      next();
    }
    audits.use(processBoundaryThen);

    // ---- the banner the client polls --------------------------------------

    audits.get("/status", (_req, res) => {
      const openId = openAuditId(ctx.db);
      const schedule = auditSchedule(ctx.db);
      res.json({
        intervalMonths: schedule.intervalMonths,
        lastAuditAt: schedule.lastAuditAt?.toISOString() ?? null,
        // lastScheduledAt rides the payload (ticket 01) so the UI can show
        // the schedule and count down to the next boundary (ticket 04)
        // without a second request; NULL when no boundary triggered the
        // last audit.
        lastScheduledAt: schedule.lastScheduledAt?.toISOString() ?? null,
        nextAuditAt: schedule.nextAuditAt?.toISOString() ?? null,
        openAuditId: openId,
        banner: { stage: bannerStage(ctx.clock.now(), schedule.nextAuditAt, openId) },
      });
    });

    // ---- open a window (bootstrap only) ------------------------------------

    audits.post("/", requireManager, (req, res) => {
      const parsed = openSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        badRequest(res, "an optional note is the only body field");
        return;
      }
      // Bootstrap-only (ADR-0002, spec decision 2): the only manual open
      // left is the very first window, and only a manager may open it.
      // From the second window on, opening is the boundary processor's job
      // — a manual open would re-anchor the cadence on an arbitrary date,
      // and the schedule must never drift off its scheduled_at anchor.
      // The boundary middleware above has already run, so this check sees
      // the post-transition state.
      const exists = ctx.db.prepare("SELECT EXISTS(SELECT 1 FROM audits) AS any").get() as {
        any: number;
      };
      if (exists.any === 1) {
        res
          .status(409)
          .json({ error: "audits already exist — windows open automatically at their boundary" });
        return;
      }
      // The bootstrap audit was triggered by no boundary, so scheduled_at is
      // NULL and it anchors the cadence on its own opened_at.
      const auditId = openAuditWindow(
        ctx.db,
        ctx.clock,
        req.currentUser!,
        null,
        parsed.data.note ?? null
      );
      res.status(201).json(serializeAuditDetail(ctx.db, getAuditRow(ctx.db, auditId) as AuditRow));
    });

    // ---- list & detail ------------------------------------------------------

    audits.get("/", (_req, res) => {
      const rows = ctx.db.prepare(`${AUDIT_SELECT} ORDER BY a.id DESC`).all() as AuditRow[];
      res.json({
        audits: rows.map((audit) => ({
          id: audit.id,
          scheduledAt: audit.scheduled_at,
          openedAt: audit.opened_at,
          closedAt: audit.closed_at,
          openedBy: { id: audit.opened_by, email: audit.opened_by_email },
          closedBy:
            audit.closed_by === null ? null : { id: audit.closed_by, email: audit.closed_by_email },
          closeKind: audit.close_kind,
          previousAuditId: audit.previous_audit_id,
          anchorAt: audit.anchor_at,
          intervalMonths: auditSchedule(ctx.db).intervalMonths,
          summary: summarize(ctx.db, audit),
        })),
      });
    });

    audits.get("/:id", (req, res) => {
      const id = parseId(req.params.id);
      const audit = id === undefined ? undefined : getAuditRow(ctx.db, id);
      if (!audit) {
        res.status(404).json({ error: "no audit with that id" });
        return;
      }
      res.json(serializeAuditDetail(ctx.db, audit));
    });

    // ---- scan a serial into the open window --------------------------------

    audits.post("/:id/scan", (req, res) => {
      const parsed = scanSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a serial is required (and optionally a note)");
        return;
      }
      const id = parseId(req.params.id);
      const audit = id === undefined ? undefined : getAuditRow(ctx.db, id);
      if (!audit) {
        res.status(404).json({ error: "no audit with that id" });
        return;
      }
      const serial = normalizeSerial(parsed.data.serial);
      const part = getPartBySerial(ctx.db, serial);
      if (!part) {
        res.status(404).json({ error: `no serialized part with serial ${serial}` });
        return;
      }
      if (audit.closed_at !== null) {
        res.status(409).json({ error: "that audit window is closed" });
        return;
      }
      const note = parsed.data.note && parsed.data.note.length > 0 ? parsed.data.note : null;
      if (scanDisagreesWithStatus(part.status) && note === null) {
        badRequest(res, NOTE_REQUIRED_FOR_DISAGREEMENT);
        return;
      }
      const { statusChanged } = applyCount(
        ctx.db,
        ctx.clock,
        req.currentUser!,
        part,
        { kind: "audit", auditId: audit.id },
        note
      );
      res.json({
        part: serializePartView(getPartBySerial(ctx.db, serial) as CountablePartRow),
        statusChanged,
      });
    });

    // ---- close: settle with no grace ----------------------------------------

    // Manager-gated (spec decision 6, ticket 03): closing — accepting the
    // shortfall or certifying the count complete — is a judgment call, and
    // both of the manager's close reasons sit behind the ONE gate. Scanning
    // and reading status stay any-authenticated-user: a tech must be able to
    // work the window without a manager standing by. requireManager is the
    // single manager-powers predicate (an admin passes through it too); no
    // route-level admin branching.
    audits.post("/:id/close", requireManager, (req, res) => {
      const parsed = openSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        badRequest(res, "an optional note is the only body field");
        return;
      }
      const id = parseId(req.params.id);
      const audit = id === undefined ? undefined : getAuditRow(ctx.db, id);
      if (!audit) {
        res.status(404).json({ error: "no audit with that id" });
        return;
      }
      if (audit.closed_at !== null) {
        res.status(409).json({ error: "that audit is already closed" });
        return;
      }
      closeAuditWindow(ctx.db, ctx.clock, audit, {
        actor: req.currentUser!,
        closedBy: req.currentUser!,
        note: parsed.data.note ?? null,
      });
      res.json(serializeAuditDetail(ctx.db, getAuditRow(ctx.db, audit.id) as AuditRow));
    });

    api.use("/audits", audits);

    // ---- cycle counting: any user, any time, any SKU ------------------------

    api.post("/cycle-counts", processBoundaryThen, (req, res) => {
      const parsed = cycleCountSchema.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, "a SKU and a serial are required (and optionally a note)");
        return;
      }
      const sku = getSkuKind(ctx.db, parsed.data.skuId);
      if (!sku) {
        res.status(404).json({ error: "no SKU with that id" });
        return;
      }
      if (sku.kind !== "serialized") {
        badRequest(
          res,
          "consumable SKUs are never cycle-counted — they are tracked for cost only"
        );
        return;
      }
      const serial = normalizeSerial(parsed.data.serial);
      const part = getPartBySerial(ctx.db, serial);
      if (!part) {
        res.status(404).json({ error: `no serialized part with serial ${serial}` });
        return;
      }
      if (part.sku_id !== parsed.data.skuId) {
        badRequest(
          res,
          `${serial} is a ${part.sku_name}, not ${sku.name} — count it under its own SKU`
        );
        return;
      }
      const note = parsed.data.note && parsed.data.note.length > 0 ? parsed.data.note : null;
      if (scanDisagreesWithStatus(part.status) && note === null) {
        badRequest(res, NOTE_REQUIRED_FOR_DISAGREEMENT);
        return;
      }
      const { statusChanged } = applyCount(
        ctx.db,
        ctx.clock,
        req.currentUser!,
        part,
        { kind: "cycle_count", skuId: parsed.data.skuId },
        note
      );
      res.json({
        part: serializePartView(getPartBySerial(ctx.db, serial) as CountablePartRow),
        statusChanged,
      });
    });
  },
};
