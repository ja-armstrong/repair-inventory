# 01 — Scan-to-add a specific serial; scanned swap prompt

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/serial-scan-add-and-swap/spec.md`.

## Comments

### 2026-10-01 — implemented

- **Query seam** (`server/domains/batches/../batchparts/queries.ts`): new
  `getScannablePart` — a part by serial WITH its SKU row (the scan names
  both unit and kind). `PartSummaryRow` gained `sku_id` (additive; all three
  SELECTs updated) so the swap's same-SKU check reads one shape.
- **Add endpoint** (`server/domains/batchparts/index.ts`): `addPartSchema`
  makes `skuId` optional and adds optional `serial`; the edge refuses both-
  given ("not both") and neither. The scan path resolves the unit up front
  (404 unknown, 409 not Available, status named), derives the SKU from the
  unit, gates the Price Add Limit on the scanned unit's effective price, and
  inside the transaction re-fetches the scanned unit — a mid-write miss
  throws `ScanRefusedError` (new; carries its HTTP status) rather than ever
  filing a Need to Order for a scanned serial. The demand fallback exists
  only on the SKU path, exactly as before. `reservePart` losing the race on
  a scanned unit reports THAT serial as no longer Available.
- **Swap endpoint**: optional `serial` on `swapSchema`; pre-transaction
  checks (404 unknown, 409 wrong-SKU, 409 not Available) plus the same
  in-transaction re-fetch through `ScanRefusedError`. Blank scan keeps the
  oldest-Available pick and its pre-check, untouched.
- **Events**: every scanned reservation (`part.reserved` on the unit,
  `device.part_reserved` on the device, and the swap replacement's
  `part.reserved`) carries `via: "serial_scan"`.
- **Web** (`web/src/components/DeviceParts.tsx`): add form gains the Serial
  scan box (a filled scan sends `serial` and omits `skuId`; submit enables
  on either); the swap form gains the Replacement serial prompt (blank =
  oldest Available; remove never sends a serial). Helper text updated.
- **Tests** (`server/tests/part-scan.test.ts`, new, 7 tests): scanned add
  reserves the scanned unit (not the oldest); scan drives the SKU and both-
  /neither-given refusals; unknown serial 404 and not-Available 409 with NO
  demand created and nothing written; the scanned unit's own price override
  snapshots; scanned swap swaps in the scanned unit (middle units untouched,
  old attachment closed as swap with the note); wrong-SKU replacement 409
  (nothing changed); unknown serial 404 and scanning the attached Reserved
  unit 409. Full suite 454/454; server and web `tsc --noEmit` clean.
- **Standing docs updated in the same change**: `docs/logic-map.md` (add and
  swap route rows), `docs/manual.md` (scan step in "Adding parts to a
  device", scanned-replacement sentence in "Swapping and removing parts").
  `docs/data-model.md` needs no change (no schema change).
