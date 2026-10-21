# 01 — Remove consumable usage (cost correction)

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/remove-consumable-usage/spec.md`.

## Comments

### 2026-10-02 — implemented

- **Migration 0021** (`server/db/migrations/0021-consumable-removal.sql`):
  nullable `removed_at` / `removed_by` (FK users) / `removal_note` on
  `device_consumables`. Soft removal, never deletion — the same philosophy as
  device_parts attachments and device soft-removal. SQLite cannot ADD a
  CHECK via ALTER, so the all-or-nothing removal write is enforced in the
  one core (guarded UPDATE `WHERE removed_at IS NULL`).
- **Cores** (`batchparts/attach.ts`): new `removeConsumableUsage` (required
  note → device 404 → terminal refusal → shared tech-removal gate → usage
  lookup scoped to the device (404), already-removed (409) → guarded
  soft-remove + `device.consumable_removed` event (usage, quantity,
  unitPriceCents, costCents, note) → `amendIfApproved` with `always` — the
  cost genuinely moved, exactly like a part removal). The post-approval tech
  gate was extracted as non-HTTP `techRemoveRefusal`; the part-removal
  route's `partEditRefusal` now delegates to it (one rule, two edges).
- **Sums narrowed to active usage**: `devicePartsCostCents`,
  `devicePostApprovalSpendCents` (consumable branch), and the expense
  report's consumable query all filter `removed_at IS NULL`;
  `listConsumablesForBatch` lists active usage only (removals live on the
  timeline). `removeConsumableRow` in queries.ts is the guarded write.
- **HTTP edge** (`batchparts/index.ts`):
  `POST .../consumables/:usageId/remove` with the required-note schema;
  response carries what was removed and the recomputed Parts Cost.
- **Web** (`DeviceParts.tsx`): each usage row gains a Remove button (same
  `removePart` permission as part removal) opening an inline required-note
  form (the demand-cancel pattern); success reloads the panel.
- **Tests**: `batchparts.test.ts` new describe (3 tests): tech removal with
  required note — cost drops to 0, listing shows no usage, row KEPT with
  removed_at/by/note, both timeline events in order with the cost in the
  payload; Open-batch gates — tech 403, manager 200 with the approval
  AMENDED (600 → 0, event verified); unknown id / another device's usage
  (404) / double removal (409). `reports.test.ts`: a usage recorded in the
  report window appears in the expenses CSV, stops counting the moment it is
  removed, and the scenario's other rows are untouched. Full suite 472/472;
  both typechecks clean.
- **Standing docs updated in the same change**: `docs/logic-map.md`
  (consumables route rows), `docs/data-model.md` (migrations table brought
  current with 0019/0020/0021 — it had stopped at 0018 — plus the
  `device_consumables` columns and the soft-removal invariant),
  `docs/manual.md` (Consumables: "Removing a recorded use").
