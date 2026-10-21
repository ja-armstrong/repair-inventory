# 03 — Status-aware batch close settlement

Status: ready-for-human

## Problem

`settleBatchParts` (`server/domains/batchparts/queries.ts:912-952`) sends **every** still-Reserved part on the batch → **Unavailable**, with no join on `devices.repair_status` and no read of `sku_buybackable`. Recoverable Buyback stock gets buried, and there is no automatic path to Buyback anywhere else once ticket 02 deletes the removal default.

## Decisions (user-confirmed)

At close, settlement becomes device-status-aware:

- **Repaired** devices: Buybackable SKU → **Buyback**; any other SKU → **Unavailable** (the part was used by the repair).
- **Unrepairable** devices: **all** parts, Buybackable included → **Available** (the repair is "reversed"; the applied part is good stock going home).
- **Additional issues present**: no change — retriage already moved their attachments to the continuation device (`moveAttachmentsToDevice`, `queries.ts:785-795`); parts stay Reserved there.
- **Denied Repair**: no change — `approveBatch` already returned those parts to stock (`returnAttachmentsToStock`, `lifecycle.ts:426-432`); if any attachment somehow remains, keep today's loud `alreadyUnavailable`/mismatch listing rather than silently guessing.

## Implementation notes

- `movePartFromReserved` (`server/domains/parts/status.ts:164-174`) is the only writer for leaving Reserved — route the new destinations through it; keep the guarded `WHERE status = 'reserved'` semantics.
- Part status-change events should distinguish the close reasons (e.g. `batch_closed_repaired_buyback`, `batch_closed_repaired_unavailable`, `batch_closed_unrepairable_available`) — system events, no user note required.
- Buying a part into Buyback must still respect the buybackable guard in `status.ts:297-306`.
- Ticket 02 must land first or in the same pass, or close becomes the only automatic Reserved→Buyback path with the removal default still live (double semantics).

## Acceptance

- Closing a batch with a Repaired device: Buybackable part lands in Buyback pool; non-Buybackable lands Unavailable, reason recorded.
- Closing with an Unrepairable device: parts land Available (Buybackable included).
- Additional-issues / Denied-Repair behavior unchanged.
- Tests cover all four terminal statuses × Buybackable/non-Buybackable.

## Doc obligations

- `CONTEXT.md` **Buybackable**: rewrite to describe the close-time transition (Repaired → Buyback) replacing the removal-default claim.
- `CONTEXT.md` **Batch**/close language if needed, `docs/logic-map.md` (close settlement graph), `docs/data-model.md` invariant area, `docs/manual.md`.

## Comments

- Origin: grilling session 2026-10-05 (spec decision 2). User rationale: "a buybackable part is… the broken screen we are sending for buyback; if not eligible, there's no value to recover, we throw it away"; Unrepairable: "the repair is reversed and the good screen we applied is recovered."
- Implemented 2026-10-05. `settleBatchParts` (`server/domains/batchparts/queries.ts`) is now device-status-aware: one `SELECT id, repair_status FROM devices WHERE batch_id = ?` feeds a single decision helper `closeSettlementFor(repairStatus, buybackable)` — Repaired: Buybackable SKU → Buyback / else Unavailable; Unrepairable: everything → Available; other terminal statuses keep the pre-ticket-03 path (Unavailable; non-Reserved parts land in the loud `alreadyUnavailable` listing). An attachment whose device has no row throws (no guessed settlement). All flips still route through `movePartFromReserved` (guarded `WHERE status = 'reserved'`). Event `reason` now distinguishes close outcomes via the exported `BATCH_CLOSE_REASONS` (`batch_closed_repaired_buyback` / `batch_closed_repaired_unavailable` / `batch_closed_unrepairable_available` / `batch_closed` for leftovers) — system events, no user note.
- Buybackable guard: `movePartFromReserved` (`server/domains/parts/status.ts`) now enforces the buyback-entry rule for the `buyback` destination (throws loudly — a caller bug, not a race), sharing one wording helper `notBuybackableMessage` with `changePartStatus`'s existing endpoint guard. This closes the hole where removals/swaps bypassed the bare endpoint's guard; the removal route's non-buybackable→Buyback choice now fails loudly (JSON 500 via the central error handler) instead of silently pooling an un-sellable part — ticket 02's route was left untouched, so a 409 pre-check there is a possible follow-up for its owner.
- Cross-domain seam found and fixed: the expense report (`server/domains/reports/queries.ts`) counted consumption by `reason: "batch_closed"` exactly; the new reasons silently emptied the CSV. It now accepts exactly the two Unavailable-settling reasons via the imported `BATCH_CLOSE_REASONS` (single source), with the module doc updated.
- Tests (`server/tests/batchlifecycle.test.ts`): new describe "close settlement is status-aware" covers all four terminal statuses × Buybackable/non-Buybackable (Repaired both ways; Unrepairable both → Available; Additional issues present with a Buybackable part staying Reserved on the continuation device; Denied Repair with both SKU flags staying in stock, empty `settled`/`alreadyUnavailable` in `batch.closed`); plus a direct guard test that `movePartFromReserved` refuses non-buybackable→Buyback before any write. The pre-existing close test's reason expectation updated to `batch_closed_repaired_unavailable`.
- `server/tests/reports.test.ts` (scenario fixture only, expectations for report arithmetic otherwise intact): batch #2's second device was Unrepairable and its migration battery was the fixture's consumed non-purchased part — under the new rules an Unrepairable device returns its parts, so that device now finishes Repaired (commented in the fixture); `batches-completed` (2,0 / total 3,0) and `tech-stats` (3 repairs, 60.0 avg) CSV rows updated to match.
- Docs: CONTEXT.md **Batch** (close settles by terminal status) and **Buybackable** (close-time Repaired→Buyback rule replaces the removal-default framing); logic-map batch lifecycle (close settlement paragraph + close route row + expenses report row); data-model `serialized_parts` invariant bullet (buybackable guard at the Reserved-leaving seam); manual §6 Closing rewritten + §8 buybackable paragraph (also removed the stale ticket-27 pre-selection claim ticket 02 had already deleted from the code — its manual line had gone stale).
- Verification: `vitest run` full suite 25 files / 496 tests ALL passing (the ticket-02-documented pre-existing failures in batchparts.test.ts and device-removal.test.ts no longer reproduce — the PO-demand seam work from this pass's tickets 09/10 is now in the tree); typecheck clean for both `tsconfig.json` and `web`. Note: `node_modules/.bin` shims were momentarily missing mid-run (concurrent npm activity) — ran vitest/tsc via `node node_modules/...` directly. No git commands beyond read-only status.
