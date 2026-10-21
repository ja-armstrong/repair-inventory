# 01 — Bottom add-device button; pre-attach SKUs/serials at device creation

Status: ready-for-human
Labels: ready-for-human

Implements `.scratch/device-preattach-and-bottom-button/spec.md`.

## Comments

### 2026-10-02 — implemented

- **Reservation core extracted** (`server/domains/batchparts/attach.ts`, new):
  `attachSkuToDevice` is THE one attach path — device lookup, terminal
  refusal, scan resolution (404 unknown / 409 not Available), SKU resolution
  and the consumable refusal, Price Add Limit gate (through the SHARED
  derived-spend helpers in queries.ts, not a parallel computation),
  amendment-note rule, then the transaction: pick (scanned unit or oldest
  Available), guarded reserve, attachment snapshot at the unit's effective
  price, the standard part/device events (`via: "serial_scan"` on scans),
  the Need to Order fallback with the guarded auto-move to Parts needed, and
  the approval amendment. Refusals come back as `{ http, message }` results
  (edges map them); races/refusals raised inside the transaction throw
  `AttachRefusedError` and are converted below the transaction so the write
  rolls back whole. Non-HTTP gate helpers (`terminalDeviceRefusal`,
  `priceAddLimitRefusal`, `amendmentNoteRefusal`, `amendIfApproved`,
  `deviceLabel`) moved here; the add, consumable, swap, and remove routes in
  `batchparts/index.ts` are now thin edges over them — the messages are
  unchanged, so no test wording moved.
- **Device creation pre-attach** (`server/domains/batches/devices.ts`):
  `createDeviceSchema` gains `preAttach` (entries of `{skuId}` or `{serial}`,
  exactly one each — both/neither is a 400 via the schema refine) and
  `preAttachNote`. Inside the SAME transaction as the device row, each entry
  calls `attachSkuToDevice` (better-sqlite3 savepoints nest); a refusal
  throws `PreAttachRefusedError`, caught at the edge, mapped to its HTTP
  status — the whole creation rolls back, nothing half-equipped. PATCH
  refuses the fields loudly (`z.never()`), since pre-attach is creation-only.
  Cross-domain direction: batches → batchparts' core, the same seam direction
  the lifecycle already uses for part settlements; no import cycle.
- **Web** (`web/src/pages/BatchDetailPage.tsx`): second **Add a device**
  button below the grid (same modal). The modal gains "Parts to pre-attach":
  the SKU picker (inline SKU creation supported) + "Add picked SKU to list",
  a serial input + "Add scanned serial to list", a removable list naming each
  entry, and a shared note field labeled required-on-approved-batch. Helper
  text states the atomic behavior. Success notice counts the pre-attached
  parts.
- **Tests** (`server/tests/device-preattach.test.ts`, new, 9 tests): device
  enters with both SKUs attached (oldest units, spare untouched, event order
  created → part_reserved ×2); no-stock SKU → Need to Order + Parts needed;
  mixed stock/no-stock; ATOMIC rollback (consumable in the list → 400 and
  zero devices, the screen never reserved; unknown SKU → 404 likewise); on an
  OPEN batch — tech refused by the price limit (409, no device), manager
  refused without the note (400, no device), manager with note → created,
  attached, approval AMENDED (signed-off cost 109.99 → 219.98); no note
  needed pre-approval; pre-attach by SCANNED serial reserves that exact unit
  (event `via: serial_scan`); unknown/not-Available serial rolls the whole
  creation back; both/neither entry refused. Full suite 466/466; server and
  web `tsc --noEmit` clean.
- **Standing docs updated in the same change**: `docs/logic-map.md` (device
  creation row + the batchparts intro naming the one core),
  `docs/manual.md` (both buttons + a "Pre-attaching parts" paragraph).
  `docs/data-model.md` needs no change (no schema change).
