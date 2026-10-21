# 01 — Picker hints, Inventory SKU search, SKU numbers, permanent create offer

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/picker-hints-inventory-search-sku-numbers/spec.md`.

## Comments

### 2026-10-02 — follow-up: consumables fold into the part-add flow

The shop could not add "iPhone 11 Pro Max Rear Mic Mesh" (a consumable): the
hint row correctly said "never reserved", but read as a dead end — and the
usage form it pointed at was easy to miss.

- **`recordConsumableUsage` core extracted** (`batchparts/attach.ts`): the
  consumables endpoint's rules (device lookup, terminal refusal, kind check,
  Price Add Limit, amendment note, usage insert + `device.consumable_used`
  event, approval amendment) are now ONE callable core, beside
  `attachSkuToDevice`. The endpoint is a thin edge; messages unchanged.
- **Parts panel**: ONE "Add a part" picker for both kinds (no kind filter).
  Picking a consumable swaps the serialized fields (serial scan, supplier,
  price) for a **Quantity** field and routes the submit to the consumables
  endpoint ("Record usage"); the standalone usage FORM is gone — the usage
  LIST stays. Submit disabled only when nothing is picked or scanned.
- **Pre-attach**: `preAttach` entries gain `quantity` (consumable SKUs only;
  a quantity on a serialized entry or a scanned serial is refused loudly);
  consumable entries record usage at quantity × unit price (default 1)
  inside the same atomic creation transaction. The modal's picker is
  kind-agnostic; consumable list rows carry an editable quantity.
- **Picker hint wording** (still used by the PO picker, which stays
  serialized-only): "consumable — its cost is recorded as usage on a device
  (quantity × price)" / "serialized — reserved onto a device as a unit".
- **Tests** (`device-preattach.test.ts`): the old "consumable refused" test
  is replaced — consumable entries now succeed (usage row quantity × unit
  price, Parts Cost includes it, nothing reserved, default quantity 1), and
  the atomic rollback is pinned by quantity-on-serialized (400),
  serial-with-quantity (400) and unknown-SKU (404) — all with zero devices
  and zero usage rows created. Full suite 468/468; both typechecks clean.
- **Docs**: manual (the Add-a-part box lists both kinds and adapts; the
  Consumables subsection; the pre-attach paragraph), logic-map (two cores in
  the batchparts intro; the devices-creation row; the consumables row).

### 2026-10-02 — implemented

- **Consumable discoverability (the reported bug)**: the fuzzy matcher
  (`skuSearch.ts`) was never broken — "rear mic mesh" matches "iPhone 11 Pro
  Max Rear Mic Mesh" at the all-words tier. The add-part picker just
  hard-filters `kind="serialized"`, which is the domain rule (consumables
  are recorded as usage, never reserved) but was silent. `SkuPicker` now
  computes the OTHER kind's matches and renders them (query-gated) as dimmed,
  non-selectable hint rows with their kind badge and a domain-truth pointer:
  "recorded as usage — never reserved" / "reserved onto a device — not
  recorded as usage". Generic wording on purpose — the picker is reused by
  the parts panel AND the add-device pre-attach form, so it must not name a
  section that is not on screen. This applies to every kind-filtered picker
  in the app, both directions.
- **Inventory SKU search** (`web/src/pages/InventoryPage.tsx`): a live
  "Search SKUs" box filters the catalog table through the same
  `searchSkus` module (one ranking, both kinds); a no-match query shows a
  plain no-match row.
- **SKU numbers**: the Inventory table gains a leading "SKU #" column
  (`#<id>`); the part's page's SKU line now reads
  `name (SKU #<id>, price)`.
- **Permanent create offer (ticket 24 follow-up, per request)**: the
  "Add '…' as a SKU" row moved out of the empty branches and renders as the
  bottom row of the list whenever `allowCreate` and the query is non-empty —
  even when SKUs match — and the expanded inline form stays open if the
  query is then cleared (`creating || query !== ""`). The module doc comment
  and the manual's picker paragraph were updated to the new contract.
- **Docs**: `docs/manual.md` — the part-add picker paragraph (hints, both
  directions), the permanent create offer, the Inventory bullet (search box +
  SKU #), and the part page's SKU line.
- **Verification**: web `tsc --noEmit` clean; full suite 467/467 (no server
  change; the search module's 19 tier tests are unchanged and pass).
