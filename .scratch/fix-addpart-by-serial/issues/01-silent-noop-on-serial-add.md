# Fix: add-part-by-serial silently does nothing on the parts panel

Status: ready-for-human

## Problem

On an approved batch (batch #1), adding a part to a device (device #4) by
scanning/typing its serial (P00446) into the parts panel and clicking
**Add part** did nothing: no request, no error, no notice — a silent no-op.
The server contract and `docs/manual.md` step 6 both say a serial scan alone
is a complete add ("no SKU pick is needed"); only the UI handler disagreed.

## Diagnosis

`web/src/components/DeviceParts.tsx` → `onAddPart` opened with
`if (!pickedSku) return;` — a filled serial with no SKU pick has `pickedSku`
null, so the handler exited before building any request. The submit button's
enabled state (`skuId !== "" || serial.trim() !== ""`) promised the scan path
worked; the handler silently broke that promise.

Reproduced against the live dev app with a browser loop: serial + note
filled, SKU empty, click → zero network requests, zero UI feedback. Control
test added server-side (`server/tests/batchparts.test.ts`, "adds a part by
scanned serial alone") proving the API accepts serial-only with 201 reserved.

## Fix

- New pure module `web/src/addPartRequest.ts`: the one add form's routing
  decision — consumable pick → usage endpoint; filled serial → parts endpoint
  with the serial alone; SKU pick → parts endpoint with the SKU; neither → an
  error string the caller shows loudly (no silent no-op submits).
- `DeviceParts.tsx` `onAddPart` now routes through it and surfaces the
  un-routable case via the panel's error line.
- `web/src/addPartRequest.test.ts`: 7 tests locking the routing contract,
  including the regression (serial-only with no SKU pick routes to parts).

## Verification

- Browser loop red → green: the same serial-only click that previously sent
  nothing now sends the POST and displays the server's answer loudly
  (verified with a bogus serial → visible "no serialized part with serial …"
  error, no data mutation).
- `npm test`: 567 passed (incl. the new server control test and the routing
  tests). `npm run typecheck`: clean.

## Comments

- 2026-10-06 (agent): Root cause was the frontend guard, not the server —
  the network log was empty on click, and the serial-only API path tests
  green. The scan-path price field still applies to a scanned unit (the
  server schema takes `price` on either path), so the routing module carries
  it on both serialized branches to preserve prior behavior.
- 2026-10-06 (agent): Diagnosis side effects on the live dev DB: one login
  token + session row for jane.doe@acme.co (minted to drive the UI
  loop). Harmless; expires/ignored. No batch/device/part data was changed —
  the red repro fired no requests and the green check used a bogus serial.
