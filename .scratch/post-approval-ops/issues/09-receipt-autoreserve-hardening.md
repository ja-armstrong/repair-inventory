# 09 — Receipt auto-reserve: harden the seam (amend approval, lifecycle check)

Status: ready-for-human

## Problem

When a PO receipt fulfills a demand, `receiveSerial` (`server/domains/purchaseorders/receiving.ts:395-472`) calls `reservePart` + `insertAttachment` **directly**, bypassing everything `attachSkuToDevice` enforces:

- No batch-lifecycle check — it will attach onto an **Awaiting-approval** or even **Closed** batch, and onto terminal-status devices.
- No `amendApproval` — the stored `approved_cost_cents` silently goes stale while the device's derived spend rises (`insertAttachment` is a bare INSERT, `batchparts/queries.ts:265-281`).
- The comment at `receiving.ts:23-25` claims the path "reuses batchparts' guarded reservePart + insertAttachment" — misleading; the only guard is the reservation status flip.

## Decision (user-confirmed)

The demand is the approval-time intent; the arrival just makes it real. Therefore:

- The auto-reserved attachment **amends the approval cost in place** (up or down) to the part's actual price (`expected.unit_price_cents` snapshot) via the existing `amendApproval` path, with a recorded event/note identifying the PO receipt as the cause.
- **Batch-lifecycle check added**: refuse (loud failure) when the demanding device's batch is **Closed**. Awaiting-approval attachment stays allowed (the demand was created through the governed attach path).
- Price Add Limit stays **exempt** for this path — no PAL check (unchanged intent).
- Correct the `receiving.ts:23-25` comment to describe what the path actually does after this change.

## Acceptance

- Receipt onto an Open, approved batch: attachment lands; `approved_cost_cents` reflects the part's price immediately; timeline shows the amendment with PO context.
- Receipt onto a Closed batch: loud refusal, part receipt itself still completes (the demand stays open for manual resolution — verify and specify the exact behavior in tests).
- No PAL gating on this path.
- Tests cover amend-up, amend-down, Closed refusal.

## Doc obligations

- `CONTEXT.md` **Purchase Order** ("auto-reserved for the originating Batch" — add the amend behavior), `docs/logic-map.md` (cross-domain write batches←purchaseorders), `docs/data-model.md` invariant 5 area, `docs/manual.md`.

## Comments

- Origin: grilling session 2026-10-05 (spec decision 9, defect note). This is the shared seam ticket 10 builds on.
- Implemented 2026-10-05. New shared seam `server/domains/batchparts/autoreserve.ts` — `autoReserveOntoDemandDevice(db, clock, params)` is THE one writer of the arrival rules: loads the demanding device via `getBatchDevice` (missing/removed device → loud throw; device removal cancels open demands, so reaching it means that invariant broke), refuses a **Closed** batch as a returned `{ ok: false, http: 409 }` result, then in one transaction: guarded `reservePart` flip → `insertAttachment` at the caller's actual price → `part.reserved` + `device.part_reserved` events (caller's `source` + cause note) → **approval amended in place** via `batches/lifecycle.ts amendApproval` when the batch is Open (recompute, so it is correct up or down; on Awaiting approval the attachment simply lands — no approval exists yet). NO Price Add Limit gate — the demand is the approval-time intent, the arrival makes it real. Never touches Repair Status (leaving Parts needed stays human). `amendApproval` itself remains the single amendment implementation; the seam only gates when to call it.
- `receiving.ts` now calls the seam and no longer imports `reservePart`/`insertAttachment`/`getBatchNumber`. ORDER CHANGED deliberately: the seam runs BEFORE the demand is fulfilled — a Closed-batch refusal must leave the demand OPEN ("manual resolution"), and fulfilling first would erase the need the refusal reports. When refused, the receipt still completes: the unit stays Available, and the refusal is surfaced loudly in the receive response (`reservationRefusal`, new optional field on `ReceiveResult`) and on the PO timeline (`po.part_received` payload). Demand fulfillment's `changes === 1` miss is now a loud throw instead of a silent skip. Header comment (old lines 23-25) rewritten to describe the seam.
- For ticket 10 (intake NTO auto-reserve): call `autoReserveOntoDemandDevice` with `source: "intake"` (or similar), your own `cause` note naming the intake, and the unit's actual price; handle the `{ ok: false }` refusal the same way (part stays Available — no demand → stays Available is already your spec line). The seam does NOT fulfill the demand and does NOT pick it — picking/FIFO stays with the caller, as `pickDemand` does for receipts.
- Tests (`purchase-orders-receiving.test.ts`, new describe): amend-up (0 → 2200 with `batch.approval_amended` note naming the PO), actual-price amendment when the unit costs less than the SKU-price estimate (amends by 2000, never the 5000 estimate — with decision 7 excluding NTO estimates from the stored total, a receipt can only ever ADD an attachment, so "down" is pinned as "actual price, never the higher estimate"; a literal total decrease on receipt is unreachable by construction), explicit no-PAL test (limit pinned to 0 via the price-limit API; reservation still lands), and Closed-batch refusal pinning the exact behavior: 200 receipt, `reserved: false`, refusal message, part Available, demand still open, zero attachments, zero amendment events, refusal on the PO timeline.
- PRE-EXISTING failures fixed here as stale expectations (per spec decision 9's outstanding definition = open + batch Open + not on a PO; domain logic in `listOutstandingDemand` and the PO create route MATCHES the spec, so tests were updated, not logic): `batchparts.test.ts` "is listable per batch and globally outstanding" now asserts the global queue is EMPTY pre-approval and both demands appear after both batches are approved (pins the gating); `device-removal.test.ts` "cancelled demand cannot be marked ordered on a PO…" now approves the batch before creating the PO (a pre-approval demand is not orderable), and its `lines[0].demandId` assertion was updated to ticket 04's `lines[0].demand.id` serializer shape (that assertion had never run since the create began failing first).
- Docs: CONTEXT.md Purchase Order (amend-in-place to actual price, PAL-exempt, Closed refusal with demand left open); logic-map receive route row + demand state machine + cross-domain write table (`device_parts` now written via `batchparts/autoreserve.js`); data-model invariant 5 (arrivals amend the approved total; Closed refuses); manual §Receiving (cost added to approved cost with the receipt as cause; Closed-batch behavior).
- Full suite: 493/496 pass; the 3 failures are `reports.test.ts` expenses/shrink CSVs — demonstrated unrelated by running `reports.test.ts` on a scratch worktree at HEAD plus ONLY my `receiving.ts` + `autoreserve.ts`: 15/15 pass there, so the failures come from concurrent in-flight edits to `parts/status.ts` / `batchparts/queries.ts` (settlement area), not this ticket. Typecheck clean.
