# 12: Reports

**What to build:** The five reports, each as a CSV download over a date range: total expenses (parts consumed by repairs + consumable usage + PO shipping), RMA recovery (per-part credits recorded at RMA completion), batches completed (batches closed with devices repaired/unrepairable counts), shrink (Damaged by Tech parts + audit-failed parts, at price, with cause breakdown), and per-tech stats (repairs completed, average hand-entered repair time, damage attributed). CSVs open cleanly in Excel and PowerBI: header row, RFC-4180-compatible quoting, date-range parameters on every report.

**Blocked by:** 06 (batch approval, close, and retriage), 08 (labels and receiving), 09 (RMA orders), 10 (audits and cycle counts), 13 (intake source feeds the expense report), 14 (one event shape feeds every report) — all data sources must exist.

**Status:** ready-for-human

- [x] Total expenses report: consumed-parts cost + consumable usage + PO shipping over the interval, with line-level detail rows
- [x] RMA recovery report: per-part credits over the interval with totals
- [x] Batches completed report: closed batches with device counts (repaired/unrepairable) over the interval
- [x] Shrink report: Damaged by Tech and audit-failed parts at price, cause-separated, over the interval
- [x] Per-tech stats report: repairs, average repair time, damage attributed, per tech over the interval
- [x] All reports are CSV downloads with a date-range picker; Excel and PowerBI import cleanly (correct headers and quoting)
- [x] API tests cover each report's numbers against a seeded scenario spanning the interval boundary

## Comments

**Endpoints** — all under the new `reports` domain (`server/domains/reports/`), all manager-only via `requireManager` (the spec frames every report as a manager story, including per-tech stats — noted here per the ticket brief). All take required `from`/`to` query parameters, inclusive on both ends:

- `GET /api/reports/expenses?from=YYYY-MM-DD&to=YYYY-MM-DD`
- `GET /api/reports/rma-recovery?...`
- `GET /api/reports/batches-completed?...`
- `GET /api/reports/shrink?...`
- `GET /api/reports/tech-stats?...`

Date validation is loud: missing params, non-YYYY-MM-DD shapes, non-existent calendar dates, and `from > to` are all 400s with messages — never a silently empty report.

**CSV contract** (identical shape on every report): `text/csv; charset=utf-8`, `Content-Disposition: attachment`, streamed through csv-stringify with CRLF record separators and RFC-4180 minimal quoting (comma/quote/newline fields quoted, inner quotes doubled). Layout: a title row echoing the range, then named sections (section title row, header row, data rows, Total row), blank line between sections. Money is a fixed two-decimal dollar string; timestamps are the stored UTC ISO strings. The client page (`web/src/pages/ReportsPage.tsx`, manager-gated nav entry) offers the date-range picker and saves each CSV as a file download.

**Row contracts:**

1. **Expenses** — section "expenses": columns `Category,Date,Reference,Detail,Amount`; rows are Consumed part (batch-close settlement events, at the device_parts snapshotted price), Consumable usage (quantity × snapshotted unit price), PO shipping (at PO creation — the ordering decision is when the spend is incurred); Total row. Second section "Non-purchased consumption (excluded from expenses)": consumed migration/salvage parts listed with their intake source and price, for transparency only, excluded from the total.
2. **RMA recovery** — "Credited parts" section (`RMA order,Completed at,Serial,SKU,Credit,Note` + Total) and "Rejected parts (no credit)" section at 0.00 credit; interval on the order's `completed_at`.
3. **Batches completed** — `Batch,Closed at,Closed by,Repaired,Unrepairable,Additional issues (retriaged),Total devices` + Total row; interval on `batches.closed_at`, counts grouped by the devices' final Repair Status.
4. **Shrink** — "Damaged by tech" (`Date,Serial,SKU,Tech,Batch,Price`), "Audit failures" (`Date,Serial,SKU,Audit,Closed by,Price`), then a "Totals" section (per cause + grand total); priced at the SKU price.
5. **Per-tech stats** — `Tech,Repairs completed,Average repair time (minutes),Damage attributed` + Total row; repairs are the acting tech's `device.status_changed → Repaired` events (Repaired is terminal, so one event = one completed repair); average is over repairs that carry a hand-entered time (blank when none); the Total row's average is over all repairs, never a mean of per-tech means.

**Expense-report intake-source handling** — per CONTEXT.md's Intake Source rule, only `intake_source = 'purchase-order'` parts are expense lines (they had a purchase cost). Consumed migration/salvage parts appear in a clearly separated second section with their price and source, excluded from the expense total — chosen over a per-row "zero-cost" flag because it keeps the total's meaning exact while still surfacing the consumption. A part with a NULL intake source throws (the write seams must always set one; migration 0013 backfilled history).

**Data sources read as they exist on disk** — events only through the one read seam (`auth/timeline.ts timelineEvents`): consumed parts = `part.status_changed` with payload `to:"unavailable", reason:"batch_closed"` (the close settlement's shape); Damaged by Tech = `part.removed`/`part.status_changed` with `to:"damaged_by_tech"` (batch removals carry the batch number, bare-endpoint changes do not); audit failures = `audit_parts.outcome='failed'` interval on `audits.closed_at`; repairs = `device.status_changed` with `to:"Repaired"`. No new migration was needed (no schema change; 0014 stays free).

**Tests** — `server/tests/reports.test.ts` seeds one ledger spanning the interval boundary (events 1ms before `from`, exactly at `from` 00:00:00.000Z, inside, exactly at `to`+1ms, and after `to`) and asserts every report's exact CSV text, including the quoted comma+quote SKU name (`Battery, Pro "Max"`), the download headers, empty-interval output, six validation 400s, and tech-role 403 on all five endpoints. 259/259 suite green, typecheck and web build green.

**Not done here** — `docs/logic-map.md`, `docs/data-model.md`, and `docs/manual.md` do not exist on disk yet (tickets 16/17 own creating them); no standing-doc line was invalidated by this change. README needed no changes (no new commands).
