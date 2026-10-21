# Spec: Scan a serial to add a specific unit; scanned swap

Two gaps in the parts-on-device flow (ticket 05's SKU pick always reserves
the oldest Available unit):

1. **Scan-to-add**: a tech must be able to scan (or type) a part's serial to
   add THAT exact unit to a device on a batch — e.g. the unit in hand is the
   one that must be used.
2. **Scanned swap**: the swap flow must PROMPT for a serial scan, so the
   replacement is the exact unit scanned rather than whatever is oldest.

## Requirements

- **Add** (`POST /api/batches/:batchId/devices/:deviceId/parts`): `serial`
  is an ALTERNATIVE to `skuId` — exactly one is given. The scan names both
  the exact unit and its SKU (no separate SKU pick, so scan and SKU can
  never disagree). Unknown serial → 404; a unit that is not Available → 409
  naming its current status. A scanned add NEVER falls back to a Need to
  Order: a scan is a physical fact about a named unit. All existing rules
  still apply (terminal device, Price Add Limit gate, amendment note,
  effective-price snapshot, events).
- **Swap** (`POST .../parts/:attachmentId/swap`): optional `serial` names
  the replacement unit. It must be the same SKU as the attached part (the
  swap rule) and Available; blank keeps the oldest-Available pick. The old
  part still goes to the chosen destination with the required note.
- **Web** (`DeviceParts.tsx`): the add form gains a Serial scan box (a
  filled scan replaces the SKU pick); the swap form gains a Replacement
  serial prompt (blank = oldest Available). Remove stays note-only.
- Every scanned reservation records `via: "serial_scan"` in its event
  payload, so the timeline shows how the unit was chosen.

## Non-goals

- No intake-on-scan: a serial that does not exist is refused; intake stays
  its own flow (PO receipt or ad-hoc intake).
- No scanning of destination/notes — only the unit identity comes from the
  scan.
