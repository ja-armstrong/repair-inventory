# 05: Parts on batches — reservation, demand, swaps

**What to build:** The parts half of the batch: adding parts to a device by SKU pulls and Reserves a specific Available serialized part (transaction-safe: two users can't reserve the same unit); when Available stock is short, a Need to Order demand record (SKU + originating batch + optional supplier link) is created instead and the device may sit in Parts needed. Same-SKU swaps are always allowed for techs. Removing a part requires choosing its destination — Available, RMA, or Damaged by Tech (attributed to the acting tech) — plus a required note. Devices get a computed Parts Cost from attached serialized parts and recorded consumable quantity usage. A device's part history shows every part ever attached, including removed ones. Reservation cannot be overridden by bare part-status changes from ticket 03.

**Blocked by:** 03 (parts catalog and inventory), 04 (batches and devices).

**Status:** ready-for-human

- [x] Adding a part by SKU to a device reserves a specific Available unit (FIFO or oldest-first) transactionally; concurrent double-reservation is impossible (demonstrated by a test attempting two racing reservations)
- [x] Insufficient stock creates a Need to Order demand record tied to the batch with optional supplier link; demand is listable per batch and globally outstanding
- [x] Consumable usage records quantity per device and rolls cost into Parts Cost; serialized parts contribute their price to Parts Cost
- [x] Same-SKU swap replaces the reserved unit with another Available unit of the same SKU; the replacement is Reserved and the old one takes a destination
- [x] Removal requires destination (Available / RMA / Damaged by Tech) + note; Damaged by Tech records the acting tech for attribution
- [x] A part's history shows every batch/device it was attached to, including past attachments
- [x] Batch UI: per-device parts list with add/swap/remove actions, demand indicators, Parts Cost per device
- [x] API tests cover reservation atomicity, demand creation, swap/removal flows with required notes, and cost computation

## Comments

Implemented in `server/domains/batchparts/` (migration `0005-batch-parts.sql`, 23 tests in `server/tests/batchparts.test.ts`, commit `29d32af`).

**Endpoints** (all session-gated; any tech may use them — no manager gates, per the approval-free pre-06 world):
- `POST /api/batches/:batchId/devices/:deviceId/parts` `{skuId, supplier?, note?}` → `{outcome: "reserved", attachment}` or `{outcome: "need_to_order", demand}` (both 201)
- `POST /api/batches/:batchId/devices/:deviceId/parts/:attachmentId/swap` `{destination, note}` (both required) → 201 `{outcome, attachment, oldPart}`; 409 when no Available unit to swap in
- `POST /api/batches/:batchId/devices/:deviceId/parts/:attachmentId/remove` `{destination, note}` → 200
- `POST /api/batches/:batchId/devices/:deviceId/consumables` `{skuId, quantity, note?}` → 201 `{usage, partsCostCents, partsCost}`
- `GET /api/batches/:batchId/parts` → per-device `{parts (incl. removed), consumables, demand, partsCost}` (one call for the whole batch grid)
- `GET /api/batches/:batchId/demand` and `GET /api/demand` (global outstanding — ticket 07's PO form reads this)
- `GET /api/parts/:serial/attachments` → every batch/device the part was ever attached to, past attachments included

**Reservation atomicity:** pick (oldest Available, `ORDER BY id LIMIT 1`) → guarded `UPDATE ... WHERE status='available'` → attachment insert → events, all inside one `db.transaction`. better-sqlite3's single synchronous connection serializes requests in Node itself; the guarded UPDATE + transaction rollback make double-reservation structurally impossible (tested: two adds racing for one unit — first reserves, second files demand). A partial unique index (`device_parts(part_id) WHERE removed_at IS NULL`) enforces "one active attachment per part" at the schema level, and a CHECK constraint refuses a half-filled removal.

**Demand record shape:** `demand_records(id, sku_id, batch_id, device_id, supplier?, status open|fulfilled, created_at/by, fulfilled_at/by)` — exactly the shape ticket 07's `purchaseorders/demand.ts` already reads; receipt (ticket 08) flips status and auto-reserves back to the originating batch.

**Decisions worth review:**
- Parts Cost prices are SNAPSHOTTED at reservation/usage time (`device_parts.price_cents`, consumable `unit_price_cents`) so costs stay stable against catalog price drift — ticket 06 approves a number that won't move underneath it.
- Demand creation auto-moves the device to "Parts needed" (from any active status; all reachable per the 04 graph). Nothing auto-returns to In progress — that stays a human status change, leaving ticket 06's close/retriage a clean seam.
- Part changes on terminal devices are refused (409); batch approval state does not exist here.
- Reservations only happen through this domain; the bare `POST /api/parts/:serial/status` endpoint's existing rejections (no INTO Reserved, no OUT OF Reserved) were kept and regression-tested.
- Web: `DeviceParts.tsx` panel on the batch page (add-by-SKU, swap/remove with destination+note, consumables, demand indicators, Parts Cost column), attachments table on the part page, additive Timeline labels.

