# 10 — Intake (salvage + migration) auto-reserves outstanding NTO demand

Status: ready-for-human
Blocked by: 09

## Problem

Only **PO receipt** fulfills NTO demand today. `parts/intake.ts` (migration/salvage intake) never touches demand — a tech salvaging an iPhone 16 screen while an iPhone 16 screen NTO is open gets an Available part and a device stuck in Parts needed.

## Decision (user-confirmed)

On serialized intake (salvage **and** migration alike — "an intake is an intake"):

- If the SKU has outstanding open demand, the part **auto-reserves FIFO to the oldest demand**, one serialized part per demand unit, attaching onto `demand.device_id` through the **same hardened path ticket 09 builds** (amend approval cost, lifecycle check).
- Multiple outstanding demands across batches: oldest first, automatic; the intake result records which batch/device received it.
- No outstanding demand → part lands **Available** as today.
- The intake flow shows a confirmation of where the part went ("Reserved to Batch #N — device …") — visible, not blocking.

## Implementation notes

- The outstanding-demand definition is `listOutstandingDemand` (`batchparts/queries.ts:457-483`): open + batch Open + not already on a PO. Reuse it — one definition, both consumers.
- Salvaged parts may carry a price override; the attachment prices at the part's own price (consistent with Part Price rules), and the approval amend follows that number.
- Demand fulfilment flips `demand_records.status` open → fulfilled with the same guarded `WHERE status='open'` semantics used in PO receipt (`receiving.ts:400`).

## Acceptance

- Salvaging one part with one open demand: part reserved to the demanding device, demand fulfilled, approval amended, confirmation shown.
- Salvaging two parts with two demands (different batches): FIFO by demand age; both fulfilled correctly.
- Salvage with no demand: part lands Available, nothing else happens.
- Migration intake behaves identically.

## Doc obligations

- `CONTEXT.md` **Need to Order** / **Intake Source**: salvage/migration intake fulfills NTO demand FIFO.
- `docs/logic-map.md` (intake → batchparts cross-domain write), `docs/manual.md`.

## Comments

- Origin: grilling session 2026-10-05 (spec decision 9). User example: "there's an NTO for iPhone 16 screen, I salvage an NTO screen, it can get autoreserved."
- Implemented 2026-10-05. `parts/intake.ts` grew an arrival pass: after the inserts (+ the migration counted refresh through `applyCount`), each part in insertion order picks the OLDEST demand for its SKU from `batchparts/queries.ts listOutstandingDemand` — the ONE outstanding-demand definition, reused unedited (open + batch Open + not on a PO), re-read per part so a demand fulfilled mid-intake naturally cannot be double-consumed. A demand WITH a device attaches through `autoReserveOntoDemandDevice` (ticket 09's seam, unmodified — the seam still does not pick or fulfill) at the part's OWN effective price via `parts/effective-price.ts resolveEffectivePriceCents` (override ?? SKU price), then the demand flips open → fulfilled with the same guarded `WHERE status='open'` UPDATE + `demand.fulfilled` event the receipt uses (inline in intake.ts, mirrored from receiving.ts; noted as a deliberate small duplicate rather than editing ticket 09's receiving.ts). A demand WITHOUT a device is fulfilled from stock with no attachment (unit stays Available) — exactly receiving's semantics. The seam's params: `source` = the intake source value ("salvage"/"migration" — more precise than a bare "intake", and it is the existing part.added vocabulary), `cause` = "auto-reserved on <source> intake (serial <serial>)".
- Refusals are surfaced, not swallowed: `{ ok: false }` from the seam leaves the part Available, the demand open, and travels in the response as `reservationRefusal` (mirroring `ReceiveResult`). NOTE: the Closed-batch refusal is UNREACHABLE through intake by construction — `listOutstandingDemand` already excludes Closed batches ("its record is finished"), and including them would mean intake attaches onto Awaiting-approval batches too, contradicting the definition's documented approval gate. The seam's lifecycle check stays as the single gate; its refusal path is covered by ticket 09's receipt tests. The intake test pins the observable Closed-batch behavior instead (part Available, demand open, zero attachments, zero amendments) plus a sibling test pinning that an Awaiting-approval batch's demand is not consumed either.
- Response shape: each part in `POST /api/skus/:id/parts` now carries `reserved`, `reservationRefusal`, `demandId`, `batchId`, `batchNumber`, `deviceId`, `deviceLabel` (batchparts' shared `deviceLabel` — model + best identifier, same vocabulary as the PO "Fulfills demand" display) alongside the existing serializePart fields. `web/src/pages/IntakePage.tsx` shows "Reserved to Batch #N — device …" per reserved part and renders any refusal in an error block — visible, non-blocking.
- Tests (server/tests/intake.test.ts, new describe, 7 tests): salvage one-part/one-demand (reserved to device, demand fulfilled with fulfilled_by, attachment at SKU price, approval 0 → 2000 with amendment note naming the intake, device.part_reserved source "salvage"); price override pins the attachment AND the amendment to the part's OWN 5000, never the 2000 SKU price; migration 2 parts / 2 demands on different batches FIFO by demand id, both fulfilled, each device got its own part, result records which batch/device received each; no demand → Available, zero attachments, zero fulfilled demands; migration one-part/one-demand identical to salvage; Closed-batch demand not consumed; Awaiting-approval demand not consumed. Suite: 504/504 pass (baseline 496 + 7 here + 1 from a concurrent ticket), reports.test.ts included and green. Typecheck clean (`tsc --noEmit` root + web).
- Docs: CONTEXT.md **Need to Order** (the general FIFO auto-reserve rule, amend/PAL-exempt/Closed-refusal) and **Intake Source** ("an intake is an intake"); logic-map `POST /api/skus/:id/parts` route row, demand state machine open → fulfilled (now names intake as a fulfiller), cross-domain table new `parts → batchparts` row; manual §10 new subsection "Where an added part can go"; data-model demand_records invariant ("fulfilled only by PO receipt" → "by an arriving part — PO receipt or intake").
