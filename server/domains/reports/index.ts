import { stringify } from "csv-stringify";
import { Router } from "express";
import type { Request, Response } from "express";
import type { AppContext, Domain } from "../../domain.js";
import { getApiRouter } from "../auth/index.js";
import { requireManager } from "../auth/session.js";
import { formatCents } from "../parts/prices.js";
import {
  batchesCompletedReport,
  buybackRecoveryReport,
  expenseReport,
  returnsRevenueReport,
  rmaRecoveryReport,
  shrinkReport,
  techStatsReport,
  type Interval,
} from "./queries.js";

/**
 * The reports domain (ticket 12): the manager CSV downloads (spec
 * stories 69–74, plus the returns-revenue report of ticket 29). Every
 * report is manager-only (requireManager) — the spec frames every one of
 * them as a manager story, including per-tech stats.
 *
 * Date-range contract, identical on every report: `from` and `to` query
 * parameters in YYYY-MM-DD form, both inclusive, validated LOUDLY — a
 * malformed, impossible, or inverted range is a 400 with a message, never a
 * silent empty report.
 *
 * CSV contract: server-generated with csv-stringify (RFC-4180 minimal
 * quoting — fields containing commas, quotes, or newlines are quoted and
 * inner quotes doubled), CRLF record separators, streamed as an attachment
 * download. Money is integer cents in storage and a fixed two-decimal dollar
 * string in the cells; timestamps are the stored UTC ISO strings.
 *
 * Layout: a title row carrying the echoed range, then sections — a section
 * title row, its header row, its data rows, and its Total row; a blank line
 * separates sections. Multi-section reports (expenses, RMA recovery, shrink)
 * keep distinct concerns distinct without inventing a second file format.
 */

type Cell = string | number;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses and validates the interval query. Returns undefined after sending
 * the 400 — the caller just returns. WHY loud: a report that silently
 * covered the wrong dates is worse than no report.
 */
function readInterval(req: Request, res: Response): Interval | undefined {
  const from = req.query.from;
  const to = req.query.to;
  if (from === undefined || to === undefined) {
    res.status(400).json({ error: "from and to query parameters are required (YYYY-MM-DD, inclusive)" });
    return undefined;
  }
  const parsedFrom = parseDateParam(res, from, "from");
  const parsedTo = parseDateParam(res, to, "to");
  if (parsedFrom === undefined || parsedTo === undefined) {
    return undefined;
  }
  if (parsedFrom > parsedTo) {
    res.status(400).json({ error: "from must be on or before to" });
    return undefined;
  }
  const fromBound = new Date(`${parsedFrom}T00:00:00.000Z`).toISOString();
  const toStart = new Date(`${parsedTo}T00:00:00.000Z`);
  const toBound = new Date(toStart.getTime() + 24 * 60 * 60 * 1000).toISOString();
  return { from: parsedFrom, to: parsedTo, fromBound, toBound };
}

function parseDateParam(res: Response, value: unknown, name: string): string | undefined {
  const refuse = (): undefined => {
    res.status(400).json({ error: `${name} must be a real calendar date in YYYY-MM-DD format` });
    return undefined;
  };
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return refuse();
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return refuse();
  }
  return value;
}

function sendCsv(res: Response, filename: string, rows: Cell[][]): void {
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  stringify(rows, { record_delimiter: "\r\n" })
    .on("error", () => {
      // The download is already committed at this point; abort the stream
      // rather than half-deliver a CSV that pretends to be complete.
      res.destroy();
    })
    .pipe(res);
}

export const reportsDomain: Domain = {
  name: "reports",
  register(app, ctx) {
    const api = getApiRouter(app);
    const reports = Router();

    reports.get("/expenses", (req, res) => {
      const interval = readInterval(req, res);
      if (!interval) return;
      const report = expenseReport(ctx.db, interval);
      const rows: Cell[][] = [
        ["Total expenses", interval.from, interval.to],
        ["Category", "Date", "Reference", "Detail", "Amount"],
      ];
      for (const line of report.lines) {
        rows.push([line.category, line.at, line.reference, line.detail, formatCents(line.amountCents)]);
      }
      rows.push(["Total", "", "", "", formatCents(report.totalCents)]);
      rows.push([]);
      rows.push(["Non-purchased consumption (excluded from expenses)"]);
      rows.push(["Date", "Reference", "Serial", "SKU", "Intake source", "Price"]);
      for (const row of report.nonPurchased) {
        rows.push([
          row.at,
          row.reference,
          row.serial,
          row.sku,
          row.intakeSource,
          formatCents(row.priceCents),
        ]);
      }
      rows.push(["Total", "", "", "", "", formatCents(report.nonPurchasedTotalCents)]);
      sendCsv(res, `expenses_${interval.from}_${interval.to}.csv`, rows);
    });

    reports.get("/rma-recovery", (req, res) => {
      const interval = readInterval(req, res);
      if (!interval) return;
      const report = rmaRecoveryReport(ctx.db, interval);
      const rows: Cell[][] = [
        ["RMA recovery", interval.from, interval.to],
        ["Credited parts"],
        ["RMA order", "Completed at", "Serial", "SKU", "Credit", "Note"],
      ];
      for (const row of report.credited) {
        rows.push([
          `RMA #${row.number}`,
          row.completedAt,
          row.serial,
          row.sku,
          formatCents(row.creditCents),
          row.note,
        ]);
      }
      rows.push(["Total", "", "", "", formatCents(report.totalCreditCents)]);
      rows.push([]);
      rows.push(["Rejected parts (no credit)"]);
      rows.push(["RMA order", "Completed at", "Serial", "SKU", "Credit", "Note"]);
      for (const row of report.rejected) {
        rows.push([`RMA #${row.number}`, row.completedAt, row.serial, row.sku, "0.00", row.note]);
      }
      rows.push(["Total", "", "", "", "0.00"]);
      sendCsv(res, `rma-recovery_${interval.from}_${interval.to}.csv`, rows);
    });

    reports.get("/buyback-recovery", (req, res) => {
      const interval = readInterval(req, res);
      if (!interval) return;
      const report = buybackRecoveryReport(ctx.db, interval);
      const rows: Cell[][] = [
        ["Buyback recovery", interval.from, interval.to],
        ["Buyback order", "Completed at", "Value"],
      ];
      for (const row of report.orders) {
        rows.push([
          `Buyback #${row.number}`,
          row.completedAt,
          formatCents(row.orderValueCents),
        ]);
      }
      rows.push(["Total", "", formatCents(report.totalValueCents)]);
      sendCsv(res, `buyback-recovery_${interval.from}_${interval.to}.csv`, rows);
    });

    reports.get("/returns-revenue", (req, res) => {
      const interval = readInterval(req, res);
      if (!interval) return;
      const report = returnsRevenueReport(ctx.db, interval);
      const rows: Cell[][] = [
        ["Returns revenue", interval.from, interval.to],
        ["Return order", "Completed at", "Serial", "SKU", "Revenue"],
      ];
      for (const row of report.parts) {
        rows.push([
          `Return #${row.number}`,
          row.completedAt,
          row.serial,
          row.sku,
          formatCents(row.priceCents),
        ]);
      }
      rows.push(["Total", "", "", "", formatCents(report.totalCents)]);
      sendCsv(res, `returns-revenue_${interval.from}_${interval.to}.csv`, rows);
    });

    reports.get("/batches-completed", (req, res) => {
      const interval = readInterval(req, res);
      if (!interval) return;
      const report = batchesCompletedReport(ctx.db, interval);
      const rows: Cell[][] = [
        ["Batches completed", interval.from, interval.to],
        ["Batch", "Closed at", "Closed by", "Repaired", "Unrepairable", "Additional issues (retriaged)", "Denied", "Total devices"],
      ];
      for (const batch of report.batches) {
        rows.push([
          `Batch #${batch.number}`,
          batch.closedAt,
          batch.closedBy,
          batch.repaired,
          batch.unrepairable,
          batch.additionalIssues,
          batch.denied,
          batch.totalDevices,
        ]);
      }
      rows.push([
        "Total",
        "",
        "",
        report.totals.repaired,
        report.totals.unrepairable,
        report.totals.additionalIssues,
        report.totals.denied,
        report.totals.totalDevices,
      ]);
      sendCsv(res, `batches-completed_${interval.from}_${interval.to}.csv`, rows);
    });

    reports.get("/shrink", (req, res) => {
      const interval = readInterval(req, res);
      if (!interval) return;
      const report = shrinkReport(ctx.db, interval);
      const rows: Cell[][] = [
        ["Shrink", interval.from, interval.to],
        ["Damaged by tech"],
        ["Date", "Serial", "SKU", "Tech", "Batch", "Price"],
      ];
      for (const row of report.damaged) {
        rows.push([row.at, row.serial, row.sku, row.tech, row.batch, formatCents(row.priceCents)]);
      }
      rows.push(["Total", "", "", "", "", formatCents(report.damagedTotalCents)]);
      rows.push([]);
      rows.push(["Audit failures"]);
      rows.push(["Date", "Serial", "SKU", "Audit", "Closed by", "Price"]);
      for (const row of report.auditFailures) {
        rows.push([
          row.at,
          row.serial,
          row.sku,
          `Audit #${row.auditId}`,
          row.closedBy,
          formatCents(row.priceCents),
        ]);
      }
      rows.push(["Total", "", "", "", "", formatCents(report.auditFailureTotalCents)]);
      rows.push([]);
      rows.push(["Totals"]);
      rows.push(["Cause", "Price"]);
      rows.push(["Damaged by tech", formatCents(report.damagedTotalCents)]);
      rows.push(["Audit failure", formatCents(report.auditFailureTotalCents)]);
      rows.push(["Total", formatCents(report.damagedTotalCents + report.auditFailureTotalCents)]);
      sendCsv(res, `shrink_${interval.from}_${interval.to}.csv`, rows);
    });

    reports.get("/tech-stats", (req, res) => {
      const interval = readInterval(req, res);
      if (!interval) return;
      const report = techStatsReport(ctx.db, interval);
      const rows: Cell[][] = [
        ["Per-tech stats", interval.from, interval.to],
        ["Tech", "Repairs completed", "Average repair time (minutes)", "Damage attributed"],
      ];
      for (const row of report.rows) {
        rows.push([
          row.email,
          row.repairs,
          row.averageRepairMinutes === null ? "" : row.averageRepairMinutes.toFixed(1),
          row.damage,
        ]);
      }
      rows.push([
        "Total",
        report.totals.repairs,
        report.totals.averageRepairMinutes === null ? "" : report.totals.averageRepairMinutes.toFixed(1),
        report.totals.damage,
      ]);
      sendCsv(res, `tech-stats_${interval.from}_${interval.to}.csv`, rows);
    });

    api.use("/reports", requireManager, reports);
  },
};
