# 13: Intake outside purchase orders — migration and salvage

**What to build:** Parts entering inventory without a PO. An Inventory intake screen with two flows: (a) **salvage** — add a single serialized part to a SKU with a required provenance note (what it came off, why it exists); (b) **migration** — bulk-add N serialized parts to a SKU for pre-existing shelf stock, where the tech confirms "physically counted now" (default on) so each part's last-counted date is set and the first audit doesn't demand the whole back room; unconfirmed means not counted. Every intake records its Intake Source (purchase order / migration / salvage) on the part and in the timeline. PO receiving stamps purchase-order source on the parts it creates (one additive edit to the receiving path). After intake, print a label sheet for the added parts — reuse the PO label rendering and the configured label size — so migrated and salvaged parts carry scannable serials.

**Blocked by:** 08 (labels, settings, receiving), 10 (last-counted mechanics).

**Status:** ready-for-human

- [x] Salvage intake: single part, required provenance note, source=salvage recorded on the part and as an event
- [x] Migration intake: N parts in one action; "physically counted" confirmation sets last-counted (tested both ways); source=migration
- [x] PO-received parts carry source=purchase-order (additive edit to the receiving path, event recorded)
- [x] Label sheet printable for freshly intake'd parts using the configured label size
- [x] Intake source is queryable per part and aggregable by source (ticket 12's expense report consumes this)
- [x] UI: intake screen with both flows and a print-labels action
- [x] API tests cover both flows, the counted-baseline rule, source stamping, and label data

## Comments

**Endpoints**

- `POST /api/skus/:id/parts` — now source-discriminated (the old ad-hoc intake, one door):
  `{ source: "migration", quantity (1–200, default 1), counted: boolean, note? }` and
  `{ source: "salvage", note (required provenance) }`. `counted` is REQUIRED on migration — no
  silent default for a domain rule; the UI's checkbox defaults to checked per the spec.
  Returns the created parts, each serialized with `intakeSource`.
- `GET /api/parts/labels?ids=1,2,3` — label data (Code 128 serials + SKU + configured label
  size) for ANY set of existing parts. Registered above `GET /:serial` in the parts router
  (route-order contract). 404s loudly naming the first missing id; never skips silently.
- `POST /api/purchase-orders/:id/receive` — unchanged contract; received parts now carry
  `intake_source = 'purchase-order'` and the `part.added` event payload includes `intakeSource`.
- `GET /api/purchase-orders/:id/labels` — unchanged shape; label size now read through the
  shared `getLabelSize` (parts/settings.ts), the one reader of the label-size settings.

**Source-stamping design**

- Migration 0013 adds `serialized_parts.intake_source TEXT CHECK (IN ('purchase-order',
  'migration','salvage'))`. Portable SQL (plain ADD COLUMN + UPDATE backfills; verified SQLite
  accepts ADD COLUMN with a CHECK on the new column).
- NOT NULL could not be added portably: SQLite has no `ADD COLUMN ... SET NOT NULL`, a NOT NULL
  default would silently falsify the source of future unwary inserts, and a table rebuild would
  have to DROP the parent table with foreign keys enforced (and `PRAGMA foreign_keys` is a no-op
  inside the migration runner's transaction). So nullability is enforced at the seams:
  `parts/intake.ts` and `purchaseorders/receiving.ts` are the only two INSERTs into
  serialized_parts and both always set the column; an invariant test asserts no NULLs exist.
- Backfill is data-derived, not guessed: parts linked from a received expected serial →
  `purchase-order`; every other pre-existing row came from the old ad-hoc bulk intake endpoint
  (the act migration intake now formalizes) → `migration`. Salvage did not exist before.
- The counted confirmation for migration goes through `applyCount` (audits/counting.ts) — the
  same mechanism a cycle count uses — with a new `CountContext` kind `migration_intake`, so
  audit due-ness treats it as a real count, and each part gets an honest `part.counted` event.

**Counted-baseline rule as built**

- `counted: true` → each part's `last_counted_at` = now via `applyCount`; a later audit's
  `duePartsAtOpen(anchor)` excludes them (tested against a real first-audit baseline).
- `counted: false` → `last_counted_at` stays NULL; the next audit demands them (tested).
- Intake while a window is OPEN: parts are exempt as `added-since-open` (pre-existing audits
  logic) and are never failed at close — covered by tests for both flows, unchanged audits code.

**Label printing generalization**

- `web/src/components/LabelSheet.tsx` extracted from `PurchaseOrderLabelsPage` (Code 128
  barcode + SKU + name, CSS from the configured sixteenths, compact-height derivation, print
  toolbar); the PO page now renders through it (its "received" mark via an optional per-entry
  flag), and the new `PartLabelsPage` (`/inventory/labels?ids=…`) renders intake'd parts with
  the same component — no copy of the rendering exists.

**UI**

- `/inventory/intake` (nav: "Intake") — flow switch (Migration / Salvage), SKU dropdown
  (serialized only, prefilled from `?sku=` for deep links from a SKU page), quantity +
  "Physically counted now" checkbox (default on) for migration, required provenance note for
  salvage; after intake, the added serials are listed with a "Print labels" link. Autofocused
  first field for keyboard/scan-gun-driven entry (intake serials are system-assigned; scanning
  starts once labels are printed). SKU detail's old ad-hoc intake form was replaced by a link
  into this screen — one intake UI, not two. Part detail and the SKU parts table now show the
  intake source.

**Other notes**

- `countPartsByIntakeSource` (parts/intake.ts) is the aggregate seam ticket 12's expense report
  consumes (plain GROUP BY over the column); tested.
- The old ad-hoc intake contract `{ quantity, note }` is gone — existing tests were updated to
  the source-discriminated contract.
- Standing docs (README/logic-map/data-model/manual) do not exist yet (tickets 16/17); nothing
  to update there in this commit. The domain-rule WHYs live as inline comments in
  parts/intake.ts, migration 0013, and the intake route.
