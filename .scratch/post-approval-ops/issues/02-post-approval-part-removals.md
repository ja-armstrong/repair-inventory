# 02 — Part removals: post-approval, terminal devices, always-explicit destination

Status: ready-for-human

## Problem

Post-approval, a tech may remove only from a device in `Parts needed` (`techRemoveRefusal`, `server/domains/batchparts/attach.ts:546-573`); other Open-batch removals are manager-only amendments; terminal devices refuse **all** part changes (`terminalDeviceRefusal`, `attach.ts:67-81`). The removal endpoint also *defaults* the destination to Buyback for Buybackable SKUs when omitted (`server/domains/batchparts/index.ts:118-124`, `573-574` — ticket 27). The shop's rule: recovery is a tech decision, never automatic.

## Decisions (user-confirmed)

- Techs may remove **any** part from **any** device on an **Open** batch — post-approval included, and from terminal-but-not-absorbing devices (Repaired / Unrepairable / Additional issues present). Refused only when the batch is **Closed**.
- Destination is **always explicit**: delete the server-side Buybackable default (`removeSchema` makes `destination` required again); the UI removal dialog starts **unselected** and submission is blocked until the tech chooses (Available / RMA / Buyback / Damaged by Tech / Unavailable). The serializer's `buybackable` flag may stay for display, but the comment at `batchparts/queries.ts:235-238` ("the removal UI pre-selects…") must be rewritten — no pre-selection anywhere.
- Note always required (already enforced — keep it).
- **Consumable usage lines** are removable under the same gates: tech, Open batch, post-approval OK, required note; cost reversal only, no stock side-effect (`attach.ts:639-670` / `removeConsumableRow` path — check its current gating).
- Removals **amend the approved cost in place** via the existing `amendIfApproved`/`amendApproval` path (`attach.ts:437`, `lifecycle.ts:924-941`) — a tech removal is not manager-gated because it only ever reduces cost; the note records why. Approved cost must never go stale on a removal.
- No device status changes, batch stays closeable, history append-only.

## Implementation notes

- `terminalDeviceRefusal` relaxation applies to **removal only** — attach/swap/status rules are untouched.
- The swap route already requires an explicit destination (`swapSchema`, `index.ts:109-111`) — leave it.

## Acceptance

- Tech can remove a part from an approved, Repaired/Unrepairable device on an Open batch; refused on Closed.
- Omitting `destination` on removal → 400 for every SKU, Buybackable included.
- UI dialog cannot submit without a chosen destination; no pre-selection.
- Consumable line removal works post-approval with note; cost drops.
- `approved_cost_cents` reflects every removal immediately (amended in place, event recorded).

## Doc obligations

- `CONTEXT.md` **Approval**: rewrite the post-approval tech-limit sentence (removals now allowed for techs; swaps/additions still PAL-limited).
- `CONTEXT.md` **Buybackable**: delete the "Removing a Buybackable part defaults to the Buyback destination" claim (replacement close-time rule lands in ticket 03).
- `docs/data-model.md` invariants 5 area (approved-cost amendment), `docs/logic-map.md` batchparts rules, `docs/manual.md`.

## Comments

- Origin: grilling session 2026-10-05 (spec decisions 1). User's exact words: "Always tech decision, never automatic for removal, note always required."
- Implemented 2026-10-05. Server: `techRemoveRefusal` is now a single Closed-batch refusal (409) — any device on a live batch qualifies, so the terminal-device gate was dropped from BOTH removal paths (part route in `batchparts/index.ts`, consumable core in `attach.ts`); attach and swap keep the terminal gate. `removeSchema` requires `destination` again (ticket-27 Buybackable default deleted). Removal still amends via `amendIfApproved(..., always=true)` — approved cost recomputes from active attachments, so it can never go stale. `amendIfApproved`'s doc updated; `techRemoveRefusal` lost its (now unused) actor parameter and `partEditRefusal` follows.
- UI (`DeviceParts.tsx`): removal dialog starts with `destination: ""`, a disabled "Choose a destination…" placeholder option, `required` on the select, and a disabled submit until chosen; no `buybackable`-driven pre-selection anywhere (the serializer flag stays display-only, comment rewritten in `queries.ts`). Swap keeps its Available default — its destination was always explicit. `BuybackPage.tsx` empty-pool text no longer claims a default.
- Tests: rewrote the ticket-27 default expectations in `buybacks.test.ts` (omitting destination now 400s for every SKU; pooled-part helpers pass `destination: "buyback"` explicitly), the ticket-30 Parts-needed-only rule in `device-removal.test.ts` (now: tech removes from any device incl. a Repaired one; Closed batch refuses 409; destination+note still required), the 403 expectation in `batchlifecycle.test.ts` (tech removal now succeeds and amends the approval), and the consumable-gates test in `batchparts.test.ts` (tech usage removal post-approval amends by the tech's actor).
- Docs: CONTEXT.md Approval rewritten (removals are tech decisions; swaps/additions still PAL-limited), CONTEXT.md Buybackable default claim deleted; logic-map batchparts remove/consumable-remove routes + buyback "Entering the pool"; manual §4 (usage removal), §5 (destination always picked by you), §6 (post-approval rules), §8 buybackable paragraph, §14 permission table (split removal from over-limit add); data-model invariant 5 notes removals amend whatever the role.
- PRE-EXISTING failures observed, NOT from this ticket (verified identical on a stashed clean HEAD): `batchparts.test.ts` "is listable per batch and globally outstanding" and `device-removal.test.ts` "cancelled demand cannot be marked ordered on a PO" — both expect pre-approval-batch demands in/with the PO demand queue, but `listOutstandingDemand` and the PO create route now gate on the batch being Open. They belong to the PO-demand seam (this pass's tickets 09/10 territory).
- WARNING for the maintainer: mid-implementation, an uncommitted-tree wipe (git checkout/restore by another session) reverted all working-tree changes; this ticket's work was re-applied in full and re-verified (typecheck + full suite). Any OTHER session's uncommitted work that was in the tree at that moment (ticket 01's batch-list fix and a PO-display pass were visible) may have been lost and should be re-checked by its owner.
