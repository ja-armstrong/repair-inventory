# Post-approval operations pass

Status: ready-for-agent
Origin: grilling session 2026-10-05 (user + agent, questions and answers recorded in session). All decisions below are user-confirmed.

## Problem

Techs cannot recover parts from devices once a batch is approved or a device is terminal, PO surfaces lie or stay silent about demand/cost state, and several ordering conveniences are missing. This pass fixes the seams found during grilling and adds the missing affordances.

## Decisions (all confirmed)

1. **Part removals post-approval / terminal devices** — Techs may remove any part from any device on an **Open** batch, post-approval included, and from terminal-but-not-absorbing devices (Repaired / Unrepairable / Additional issues present). Refused only when the batch is **Closed**. Destination is **always the tech's explicit choice** — no server default, no UI pre-selection, submission blocked until chosen; note always required. The ticket-27 Buybackable removal default is deleted. Consumable usage lines are removable under the same rules (cost reversal, no stock effect). Removals **amend the approved cost in place** (same `amendApproval` path), recorded by note; history stays append-only; no device status changes.

2. **Status-aware close settlement** — replaces today's blanket Reserved→Unavailable in `settleBatchParts`:
   - Repaired devices: Buybackable SKU → **Buyback**; other SKUs → **Unavailable** (the part was used by the repair).
   - Unrepairable devices: **all** parts (Buybackable included) → **Available** — the repair is "reversed" and the applied part is recovered.
   - Additional issues present: unchanged (parts move to the retriage continuation device, stay Reserved).
   - Denied Repair: unchanged (parts returned at approval).
   Rationale: Buybackable exists to recover value from *broken replaced* parts; on an Unrepairable device nothing was replaced, so parts are simply good stock.

3. **PO display** — while Awaiting approval the lines table shows a single **Quantity** column; Ordered/Received/Shortfall columns and the header "Marked ordered"/"Shortfall" chips appear only from approval onward. "Fulfills demand" renders **"Batch #N — <device identifier>"** (batch number + IMEI/serial/asset of the demanding device), not the bare demand id.

4. **Batch list status line** — root cause found: the list route's ad-hoc SELECT omits `b.status` (and approved/closed fields), then lies with `as BatchRow`; `serializeBatchSummary` emits `undefined` and JSON drops the key → blank cells. Fix by routing through the shared `BATCH_SELECT`.

5. **Device Loc/Bin** — one optional free-text field; any tech edits inline, no note required (current-state field, not an event); shown on the device row; included in device search.

6. **PO shipping cost edit** — no PO edit route exists at all today. Add a manager-only, required-note path to set shipping cost in any pre-Closed status; rolls into PO total and expense reporting.

7. **Approval cost & NTO** — stored `approved_cost_cents` keeps excluding NTO parts (a demand is an estimate, not a signed-off cost), but display becomes honest: "NTO — est. $<SKU price>" instead of $0.

8. **Device model picker** — same fuzzy search as SKU search; inline create-if-missing (techs may extend the model list); selecting a model immediately filters SKU suggestions.

9. **Intake auto-reserve** — salvage **and** migration intake auto-reserve onto outstanding NTO demand, FIFO to oldest, one serialized part per demand; no demand → stays Available. All auto-reserved attachments (PO receipts included) **amend the approval cost** to the part's actual price and gain a batch-lifecycle check (refuse attach onto Closed). They stay exempt from the Price Add Limit: the demand is the approval-time intent; the arrival just makes it real.

10. **SKU default source link** — one free-text link per SKU (`source.com/part` style); pre-fills new PO lines and NTO supplier; any PO-line source that parses as a URL renders clickable; free text remains valid.

11. **Batch list opening-note column** — new column after Batch: the creation note, truncated with full text on hover.

## Defects found during grilling (folded into tickets)

- Batch list route duplicate query drops `status` (+5 more fields) — ticket 01.
- PO-receipt auto-reserve bypasses approval amend and lifecycle checks; misleading comment at `receiving.ts:23-25` — ticket 09.

## Tickets

01 batch-list status fix + opening-note column
02 post-approval & terminal-device part removals (destination always explicit, amend-in-place, consumables)
03 status-aware close settlement
04 PO pre-approval display + "Fulfills demand" labels
05 PO shipping cost edit
06 NTO estimate display
07 device-model fuzzy search
08 device loc/bin
09 receipt auto-reserve hardening
10 intake (salvage + migration) NTO auto-reserve — blocked by 09
11 SKU default source link

## Doc obligations

Every ticket updates the standing documents it invalidates: `CONTEXT.md`, `docs/data-model.md`, `docs/logic-map.md`, `docs/manual.md` (and README only if run instructions change). Known CONTEXT.md lines to rewrite live in tickets 02 and 03.
