# 27: Buybacks — a supplier sell-back flow mirroring RMA

**What to build:** A replaced part often has resale value (an iPhone 11 screen into MobileSentrix's LCD program). A buyback flow parallel to RMA:

- **SKU flag**: `buybackable` (serialized SKUs only) — editable on the SKU detail page alongside kind, note required on change (`sku.buybackable_changed` event).
- **Removal destination**: a buybackable SKU's part, when removed from a device, **defaults to the Buyback destination** (status `buyback`, auto-eligible for the buyback pool). The tech may override with the required note and pick another destination (Available / RMA / Damaged by Tech) — "screen too destroyed" lands on Damaged.
- **Buyback pool**: all `buyback`-status parts, listed like the RMA pool. A part can be overridden out of the pool before shipment — `{destination, note}` (Available / RMA / Damaged by Tech / Unavailable) — loudly evented.
- **Buyback order**: like an RMA order — create (required note, sequential number), scan-to-add from the pool, In-Transit → Complete (any user, required note). On Complete: sold parts become **Unavailable** with a per-part **sale price** (the recovery revenue, mirroring RMA credits; rejected parts at 0 with disposition noted).
- **Seams**: mirror the RMA domain's structure and the consolidated status/timeline seams — `buyback` joins the part-status module's vocabulary and guarded transitions (parts attached to an in-transit buyback order refuse bare status changes, like RMA); audits treat buyback-pool parts like RMA-bin parts (exempt while pooled — noted for review); search finds buyback orders by number.
- **Reporting**: a buyback-recovery CSV mirroring RMA recovery (sold parts + sale prices + total revenue over an interval).
- **UI**: Buyback page beside RMA in the nav; SKU detail gains the buybackable checkbox; the removal flow shows Buyback as the default destination for buybackable SKUs.

**Blocked by:** 23 (done), 26 runs after this.

**Status:** ready-for-human

- [x] SKU buybackable flag (serialized-only, note-required change, event)
- [x] Removal defaults to Buyback for buybackable SKUs; override = other destination + note (tests both ways)
- [x] Pool listing + pool override with destination + note (tests)
- [x] Buyback order lifecycle mirroring RMA: create/scan-to-add/In-Transit/Complete with per-part sale price (tests, including refusal rules for attached parts)
- [x] Buyback-recovery CSV endpoint + reports page row
- [x] Search matches buyback orders; audit exemption consistent with RMA (test)
- [x] Full suite, typecheck, build green; docs (logic-map, data-model, manual, README nav mentions) in the same commit

## Comments

**Migration 0016 grew beyond the plan's expectation, for a structural
reason.** The Buyback status had to enter TWO CHECK constraints —
`serialized_parts.status` (so the pool can exist) and
`device_parts.removed_to` (so the default removal destination is recordable)
— and SQLite cannot ALTER a CHECK. `serialized_parts` is a PARENT table
(device_parts, rma_order_parts, audit_parts, purchase_order_expected_serials
reference it) and foreign keys stay enforced (ADR-0001), so the migration is
the full 0015 cascade pattern extended: copy the parent and all four
children, drop the children first, drop the parent, rename the copy back
(SQLite's RENAME rewrites the children's REFERENCES clauses), rename the
children back, recreate every index. No PRAGMA, no FK disabling, no row
changed. `skus.buybackable` was a plain portable ADD COLUMN (NOT NULL
DEFAULT 0 is truthful: nothing was buybackable before).

**Seams extended, mirroring RMA exactly:**
- `parts/status.ts`: `buyback` joins the PartStatus vocabulary;
  `openInTransitBuybackOrder` mirrors `openInTransitRmaOrder`; the bare
  endpoint refuses parts attached to an in-transit buyback order (the
  shipment owns them until Complete) AND refuses setting → buyback on a
  non-buybackable SKU (CONTEXT.md: Buybackable — a part the program does not
  take would sit in the pool forever). New via `buyback_complete` for the
  order's settlement.
- SKU flag: `buybackable` accepted at create and PATCH; a CHANGE requires a
  note (`sku.buybackable_changed`, from/to/note); refused on consumable SKUs,
  and a buybackable SKU cannot become consumable until the flag is off.
- Removal (batchparts): destination now optional — omitted resolves to
  `buyback` for a buybackable SKU, and stays required for anything else (a
  removal never guesses). The attachment JSON carries `sku.buybackable` so
  the UI pre-selects the same default the server applies.
- Buybacks domain (`server/domains/buybacks/index.ts`, registered in
  bootstrap): order lifecycle mirroring RMA (create/scan/In-Transit →
  Complete with `sold` + required sale price or `rejected` + none; every
  part → Unavailable via `changePartStatus` expectedFrom 'buyback'), the
  pool endpoint, and the pool override endpoint
  (`POST /api/buyback-parts/:id/override`) routed through the part-status
  module's part_endpoint guards.
- Audits: `buyback` / `buyback-in-transit` exemption reasons mirror RMA's;
  `scanDisagreesWithStatus` includes buyback (a scan wins the same way).
- Search: buyback orders match by exact number, same rule as RMA.
- Reports: `buybackRecoveryReport` (sold with sale prices, rejected at zero,
  loud on inconsistency) + `GET /api/reports/buyback-recovery` CSV +
  ReportsPage row.

**Tests** — `server/tests/buybacks.test.ts` (16): flag create/patch rules and
event; removal default both ways (omitted → buyback; explicit override →
damaged_by_tech; non-buybackable still requires a destination); bare-endpoint
→ buyback refused on a non-buybackable SKU and allowed on a buybackable one;
pool listing + override (note required, evented, out of the pool, write-off
included); order lifecycle (note required, scan refusals, one-open-order,
complete validation matrix — empty/missing price/price-on-rejected/missing
part/double-complete/scan-after-complete); in-transit guard names the order;
order revenue totals; search hit; recovery CSV; audit exemption. Legacy
pins updated: admin migration count 15→16, search "all groups empty" gains
`buybackOrders: []`.

**Full suite 387/387, typecheck and build green.** UI: Buyback nav page
beside RMA (list + pool + scan-first detail + per-part Complete flow with
sale price), SKU page buybackable checkbox (serialized only), removal flow
pre-selects Buyback for buybackable SKUs, part page offers Buyback as a
settable status (the server's refusal stays the authority for non-buybackable
SKUs), search results and reports page extended. Docs: logic-map (buybacks
domain section, routes, matrix), data-model (0016, columns, invariants),
manual (status table, removal destinations, section 8 retitled to cover
buybacks step by step, reports list), README (Buyback Orders in the intro).
