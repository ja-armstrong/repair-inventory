# Spec: Add-device button at the bottom; pre-attach SKUs/serials at device creation

Two additions to the batch page's device flow:

1. **Bottom button**: the Add-a-device button currently sits only ABOVE the
   device grid; a long batch forces a scroll back to the top. Add the same
   button below the grid.
2. **Pre-attach in the add-device modal**: a tech adding a device usually
   knows which parts it needs. The modal should let them list serialized
   parts — picked SKUs and/or scanned serials — so the device ENTERS the
   batch with them already attached (rather than create-then-attach by hand).

## Requirements

- The pre-attach goes through THE reservation rules, not a parallel path:
  extract the add-part handler's reservation core into a callable module
  (`batchparts/attach.ts attachSkuToDevice`) and have BOTH the add-part
  endpoint and device creation use it. One writer of: pick (scan or oldest
  Available), guarded reserve, attachment, events, Need to Order fallback
  with the auto-move to Parts needed, terminal refusal, Price Add Limit
  gate, amendment note rule, approval amendment.
- Device creation accepts `preAttach`: a list of entries, each exactly one
  of `{skuId}` or `{serial}` (a scan names unit AND SKU; both/neither is a
  400). Every entry attaches INSIDE the same transaction as the device row —
  atomic: any refusal (unknown SKU/serial, consumable SKU, Open-batch note
  rule, tech over the price limit) rolls the WHOLE creation back; the device
  never enters half-equipped, and the response names the reason.
- Pre-attach is creation-only: the device PATCH schema refuses the fields.
- Web modal: SKU picker (with inline SKU creation) + a serial input, both
  feeding a removable list; a shared note for the attached parts (required
  on an approved batch, per the existing rule); helper text stating the
  atomic behavior.

## Non-goals

- No per-entry prices or suppliers in the modal (the parts panel remains the
  place for price overrides and supplier links).
- No partial creation on failure — atomic or nothing.
