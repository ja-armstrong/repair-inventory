# Spec: Consumable discoverability in the pickers; Inventory SKU search; SKU numbers

Three items from the shop:

1. **Consumables invisible in the part-add picker.** Searching the
   "Add a part by SKU" box for a consumable ("iPhone 11 Pro Max Rear Mic
   Mesh" on Batch #2 device #50) shows NOTHING. Root cause: the picker
   filters `kind="serialized"` — correct per the domain (consumables are
   recorded as usage, never reserved), but silent, so it reads as "the
   catalog lacks this item" and invites creating a duplicate serialized SKU.
   The picker must surface other-kind matches as dimmed, non-selectable hint
   rows that say where the SKU belongs.
2. **SKU search on the Inventory screen**: filter the catalog table with the
   SAME fuzzy matcher the pickers use (one ranking module), both kinds
   included.
3. **SKU numbers** on the Inventory table and the part's page.

## Requirements

- SkuPicker: when a `kind` filter is active and the query is non-empty,
  matching SKUs of the OTHER kind render after the results (and in the
  no-results state) as dimmed, non-selectable rows with their kind badge and
  a domain-truth hint ("recorded as usage — never reserved" /
  "reserved onto a device — not recorded as usage"). No location-specific
  wording — the picker is reused by the parts panel AND the add-device
  pre-attach form.
- InventoryPage: a live "Search SKUs" box over the whole catalog + a
  "SKU #" column (`#<id>`); a query matching nothing shows a plain
  no-match row.
- PartDetailPage: the SKU line shows the SKU number ("SKU #<id>") beside the
  name and price.
- SkuPicker (ticket 24 follow-up): the **Add "…" as a SKU** offer becomes a
  PERMANENT bottom row of the results list — shown even when SKUs match the
  fuzzy search — so a new part can be created from any search without
  clearing the query first. The empty branches keep only their messages.
