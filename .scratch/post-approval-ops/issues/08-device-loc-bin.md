# 08 — Device Loc/Bin field

Status: ready-for-human

## Problem

Devices have no physical-location field anywhere (`devices` table: `data-model.md:267-295` — no loc/bin columns exist; grep over `server/` confirms none). Techs cannot record where a device sits in the shop.

## Decision (user-confirmed)

One optional **free-text** field, single combined "Loc/Bin" (not two fields):

- Migration: `devices.loc_bin TEXT NULL` (next migration number — 0023 as of this writing; renumber in implementation order if 09/11 land first).
- Any tech can edit it **inline on the device row**, **no note required** — it is a current-state field, not an event.
- Displayed on the device row (batch detail).
- Included in **device search** (`GET /api/search` device-identifier matching gains loc/bin as a matchable field — substring, consistent with the search domain's style).
- Nullable/empty renders as "—"; never a silent blank.

## Acceptance

- Tech sets/clears loc/bin inline; no timeline event required or written.
- Search by loc/bin text finds the device.
- Migration is reversible and follows the repo's migration conventions.

## Doc obligations

- `docs/data-model.md`: `devices.loc_bin` column + invariant note (current-state, no history).
- `docs/logic-map.md` (search domain read), `docs/manual.md`.

## Comments

- Origin: grilling session 2026-10-05 (spec decision 5). "Loc/bin on devices (optional)."
- 2026-10-05, implemented (agent):
  - `server/db/migrations/0024-devices-loc-bin.sql` — `ALTER TABLE devices ADD COLUMN loc_bin TEXT;` (numbered 0024 because ticket 11's 0023 landed first, per the renumber note). The repo has no down-migration convention (0020/0022 are forward-only; the runner records applied files and forbids gaps/renumbering), so "reversible" is satisfied by construction: one additive ALTER with no index/constraint/backfill, and the exact reverse statement (`ALTER TABLE devices DROP COLUMN loc_bin;`) is documented in the file header.
  - `server/domains/batches/devices.ts` — `locBin: clearableText` on `createDeviceSchema` (the edit schema extends it), so create and PATCH share one validation and one PATCH semantics rule: absent = unchanged, present-but-empty = cleared. The INSERT carries the column. In the PATCH route, loc_bin is deliberately OUTSIDE the evented `next`/`labels` maps: it updates the column when changed but never enters the `device.edited` payload, and a loc/bin-only edit writes no event at all (current state, not history — the WHY is commented at both the route and the module header). No note is required; the route stays open to any tech (no role gate added).
  - `server/domains/batches/serialize.ts` — `loc_bin` added to `DeviceRow`, both device SELECTs (base + cross-batch history), and `serializeDevice` as `locBin` (null stays null; the client renders "—").
  - `server/domains/search/index.ts` — `searchDevices` gains `OR (d.loc_bin IS NOT NULL AND LOWER(d.loc_bin) LIKE ? ESCAPE '\')`: case-insensitive SUBSTRING (the SKU rule — loc/bin is free text, not an identifier), wildcard-escaped via the domain's shared `escapeLike`; removed devices stay filtered out. The device hit carries `locBin` so a results row can show where the device sits. The domain header's match-semantics list documents the exception.
  - `web/src/pages/BatchDetailPage.tsx` — new **Loc/Bin** column on the device grid (after Capacity) with an inline `LocBinControl` (same per-row-control pattern as `StatusControl`/`ApprovalControl`): input seeded from the current value, Save PATCHes `{ locBin }`, unset renders the "—" placeholder (never a silent blank), saving an emptied cell clears. The add-device modal and the edit modal carry the same field. UI is not component-tested — the repo's only web tests are pure-function modules (`skuSearch.test.ts`); the behavior is pinned at the API level and by typecheck.
  - Tests: `server/tests/device-loc-bin.test.ts` (9) — tech sets/clears inline with no note; unset serializes null; loc/bin-only edit writes NO event (events table asserted directly); a mixed edit's `device.edited` payload contains the other field but never locBin; creation accepts the field; search finds by case-insensitive substring and carries `locBin`; unset loc/bin never matches; LIKE wildcards escaped (`Bin_1` vs `BinX1`).
  - Docs: `docs/data-model.md` (devices section header + `loc_bin` column row + "current state, no history" invariant bullet), `docs/logic-map.md` (PATCH device route row + GET /api/search row), `docs/manual.md` (Loc/Bin field-table row in "Adding devices", including the inline edit and no-timeline behavior, + a search-table row). CONTEXT.md untouched — not obligated and its Device entry states nothing this change contradicts.
  - Verified: full suite 513/513 green (26 files, exit 0; 504 pre-existing + 9 new). Typecheck of MY files clean; the only `tsc -p web` error is `PurchaseOrderCreatePage.tsx` "SourceText declared but never read" — ticket 11's in-progress file, not this ticket's.
