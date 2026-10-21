# Spec: Remove consumable usage from a device

Recorded consumable usage is insert-only: a mistaken entry (wrong quantity,
wrong device) permanently inflates the device's Parts Cost and the expense
report. There must be a way to remove it — with the same seriousness every
other removal has.

## Requirement

- `POST /api/batches/:batchId/devices/:deviceId/consumables/:usageId/remove`
  with a REQUIRED note, through a consumable core
  (`removeConsumableUsage` in batchparts/attach.ts) beside the usage core.
- The usage row is SOFT-removed (migration 0021: `removed_at` / `removed_by`
  / `removal_note`) and kept — Parts Cost and the expense report sum only
  active usage (`removed_at IS NULL`), so the correction moves the cost
  forward while every past record stays auditable. A
  `device.consumable_removed` event records usage, cost, and note.
- Same gates as part removal: terminal devices refuse; on an Open batch a
  tech may remove only from a device in Parts needed (shared non-HTTP gate
  with the part-removal route), and a manager's removal amends the standing
  approval with the note.
- Loud refusals: note missing (400), unknown usage / another device's usage
  (404), already removed (409), raced removal inside the transaction (409).
- Web: each usage row in the parts panel gets a **Remove** button (same
  permission as part removal) with an inline required-note form.

## Non-goals

- No editing of quantity in place — remove and re-record (the note trail
  stays truthful).
