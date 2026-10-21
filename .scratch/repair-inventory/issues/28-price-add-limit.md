# 28: Per-device price add limit (contract spend caps)

**What to build:** B2B contracts cap per-device spend. During Awaiting approval, a manager sets an optional **price add limit** per device (default $0 = today's behavior). After the batch is Open, a tech may add parts — and record consumable usage — on that device as long as the device's post-approval cost additions stay within the limit.

- **Data**: `devices.price_add_limit_cents` INTEGER NOT NULL DEFAULT 0 (migration 0017 — verify the free number on disk; 0014–0016 are taken). Manager-set during Awaiting approval via the existing per-device approval endpoint (extended: `{decision, priceAddLimitCents?, note?}`); a manager may change it later in place (event `device.price_limit_changed`, old→new). A UI convenience applies one limit to all undecided devices at once (N calls to the same endpoint).
- **Spend accounting (derived, not stored)**: spend = the snapshot-cost sum of the device's active attachments created **after** the batch's `approved_at`, plus consumable usage created after it. Swaps: the removed part drops out, the replacement counts (mirrors Parts Cost). Pre-approval additions are covered by the approved total and never count against the limit.
- **The gate** (in the batchparts add/consumable endpoints): if `spend + this addition's cost > limit` → refuse 409 naming the device's limit, spend so far, this addition's cost, and the three options (manager override — a manager can still add in place via the amendment flow; set Additional issues present → retriage; Unrepairable). Equal-to-limit is allowed ("up to"). Price overrides (ticket 23) count at their effective price.
- **Not gated**: same-SKU swaps (existing tech right, cost-neutral by rule), manager additions (the manager IS the override), retriage/unrepairable transitions.
- **UI**: limit input beside approve/reject during approval (+ apply-to-all-undecided); on Open devices show remaining headroom; the add-part flow surfaces the limit and remaining room; refusal messages carry the options.
- **Retriage resets**: a new batch is a new approval cycle with a fresh limit (the old device's limit does not carry).

**Blocked by:** 25 (done — this extends its machinery).

**Status:** ready-for-human

- [x] Migration + manager-set limit during approval, changeable later manager-only with an event (tests)
- [x] Spend accounting derived from post-approval attachments + consumable usage (test: pre-approval additions don't count; swaps count the replacement)
- [x] The gate: within-limit addition succeeds; over-limit refused naming limit/spend/cost/options; equal-to-limit succeeds; manager additions bypass (tests)
- [x] UI: limit during approval with apply-to-all-undecided, headroom display, refusal messages
- [x] Full suite, typecheck, build green; docs (logic-map, data-model, manual) in the same commit

## Comments

**Migration 0017** (verified free on disk — the plan's "0017" was right this
time). One portable `ADD COLUMN`: `devices.price_add_limit_cents` INTEGER
NOT NULL DEFAULT 0, CHECK >= 0. DEFAULT 0 is truthful AND means "no
headroom", not "unlimited" — 0 reproduces the pre-ticket behavior exactly
(a tech could add nothing post-approval), which is what "default $0 =
today's behavior" means.

**The limit's lifecycle.** Set with the per-device approval decision
(`decideDeviceApproval` gained `priceAddLimitCents?` — whole cents ≥ 0,
validation at the edge AND the module; omitted keeps the standing value, so
re-deciding never silently zeroes a limit; the `device.approval_decided`
event carries it when given). Changed later in place by a manager only via
the new `PATCH /api/batches/:batchId/devices/:deviceId/price-limit`
(`changeDevicePriceLimit`): allowed on Awaiting-approval and Open batches,
refused on Closed (final costs), `device.price_limit_changed` records
old → new (optional note carried when given). Lowering below the already-
spent amount is allowed — future additions simply refuse; the event says
what happened. A retriaged continuation row starts at the DEFAULT (0) — the
retriage INSERT never copied it, and a comment on that INSERT now says why.

**Spend derivation — DERIVED, never stored**
(`batchparts/queries.ts devicePostApprovalSpendCents`): the snapshot-cost
sum of the device's ACTIVE attachments created strictly AFTER the batch's
`approved_at`, plus consumable usage recorded after it. Strictly-after (`>`)
matches the ticket's "created after approved_at"; an addition in the same
instant as approval counts as pre-approval (the FakeClock exposes this
immediately — tests advance the clock past approval). Swaps need no special
code: the closed attachment stops being active (drops out) and the
replacement's new attachment counts — mirroring Parts Cost. Price overrides
count at their effective price because the snapshot IS the effective price
(ticket 23). Loud on inconsistency: an Open batch without `approved_at`
throws rather than deriving a silently-zero spend.

**The gate** (`batchparts/index.ts priceLimitRefusal`) — runs in the add and
consumable endpoints BEFORE the note check, only for techs on Open batches
(managers bypass; Awaiting-approval batches are pre-approval and free):
`spend + addition > limit` → 409 whose message names this addition's cost,
the device (model + best identifier), the spend so far, the limit, and the
three options verbatim: a manager override in place (amending the approval),
retriage via Additional issues present (fresh limit on the new batch), or
Unrepairable. Equal-to-limit is allowed. The add endpoint's prospective cost
is the snapshot the reservation would take — the tech's supplied price
override when given, else the oldest Available unit's effective price (a
pre-transaction read, same pattern as the swap endpoint's friendly
pre-check; the transaction re-picks under its race guard). NOT gated: the
Need to Order demand path (no cost until a unit exists — tested), same-SKU
swaps (own endpoint; tested: a swap succeeding with a limit smaller than the
replacement proves it), status transitions, manager additions.

**Two deliberate behavior shifts from ticket 06, both tested:**
- `partEditRefusal` is now the REMOVE-only gate (403); techs may add/record
  usage on an Open batch subject to the limit, so `partEditPermissions
  .addPart`/`.consumable` are always true (the UI always offers the form;
  whether an add fits is per-request). A tech's in-limit addition does NOT
  amend the standing approval — the limit IS the pre-authorization; the
  manager override (which the refusal message offers) does amend
  (`amendIfApproved` is now manager-only). `amendmentNoteRequired` still
  requires a note on an Open batch for everyone; its message was generalized
  ("records why the cost moved") since a tech's note is a record, not an
  amendment.
- The legacy ticket-06 test was reworked accordingly: default-limit-0 tech
  add/consumable → 409 gate refusal (the consumable call now uses a real
  consumable SKU — the old test's serialized SKU hit the kind check, which
  the old 403 had masked), remove stays 403, swap 201.

**Known seam, out of scope by the ticket's wording:** the PO-receipt
auto-reserve (purchaseorders/receiving.ts) inserts attachments onto
demanding devices without passing this gate. The ticket scopes the gate to
"the batchparts add/consumable endpoints"; a receipt is its own action by
whichever user receives. Flagged here for a future ticket.

**UI.** Approval column: a price-add-limit input (dollars → cents; blank =
keep) beside the rejection note, shown on both Approve and Reject; the
approved state displays "approved · limit $X". Approval section: an
"Apply limit to undecided" form when undecided devices exist — one PATCH to
the price-limit endpoint per undecided device (the ticket suggested N calls
to the decision endpoint, but that would DECIDE the devices; the PATCH
endpoint applies the limit without touching decisions — same convenience,
honest semantics). Parts panel: "Price add limit $X · added since approval
$Y · remaining $Z" (remaining can go negative after a manager override).
Note labels now say "(required on an approved batch)".

**Tests** — `server/tests/price-add-limit.test.ts` (14): limit set/kept/
validated + event; manager change + event + tech 403 + Closed 409; spend
derivation (pre-approval exclusion, consumable usage, post-approval part,
swap drop-and-count, effective-price override); the gate (within-limit
succeeds without amending, equal-to-limit succeeds, over-limit 409 with
message contents + nothing written, manager bypass + amendment, consumable
gate, default-0 refusal + demand path); retriage reset. Admin migration
count 16 → 17.

**Full suite 401/401, typecheck and build green.** Docs in the same commit:
logic-map (approval state machine with the limit + gate, both device routes),
data-model (0017, column, the derived-spend definition and gate contract),
manual (Approval section, add-part section, who-can-do-what).

**Flagged for the orchestrator:** `web/src/pages/BatchesPage.tsx` carried an
uncommitted working-tree edit I did not make (the batch-create placeholder
changed to "Be specific.") that appeared mid-session. It is excluded from
this commit and left in the working tree untouched.
