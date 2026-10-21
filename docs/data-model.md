# Data model

Every table in migration order: columns, types, CHECK constraints, unique and
partial indexes, foreign keys — and the invariants the application enforces
beyond the schema. Vocabulary is [CONTEXT.md](../CONTEXT.md); the domain
behavior behind each table is in [docs/logic-map.md](logic-map.md).

Storage is SQLite (ADR-0001: prototype now, Postgres migration target). Every
timestamp is a UTC ISO-8601 TEXT string stamped through the injectable clock;
every money amount is an INTEGER of cents named `*_cents` with a `>= 0` CHECK —
dollars exist only at the API edges. The database opens in WAL mode with
foreign keys enforced; migrations are portable SQL only (no SQLite-only
features), so a dump-and-load into Postgres stays mechanical.

Two databases, one schema. The production file (default
`data/repair-inventory.sqlite`) and the sandbox instance's file
(`data/sandbox.sqlite`, same directory) both open at startup and both run the
full migration list below; the sandbox exists so training and feature testing
never touch production rows (spec: sandbox environment). Every invariant in
this document holds in each database independently — no table, row, session,
or cookie crosses between the two instances.

## Migration list (table of contents)

| Migration | What it creates / changes |
| --- | --- |
| `0001-migrations-table.sql` | `migrations` |
| `0002-users-sessions-events.sql` | `users`, `login_tokens`, `sessions`, `events` |
| `0003-parts.sql` | `skus`, `serialized_parts`, `app_settings` (seeded) |
| `0004-batches.sql` | `device_models`, `batches`, `devices` |
| `0005-batch-parts.sql` | `device_parts`, `device_consumables`, `demand_records` |
| `0006-purchase-orders.sql` | `purchase_orders`, `purchase_order_lines`, `purchase_order_tracking`, `purchase_order_demand` |
| `0007-rma-orders.sql` | `rma_orders`, `rma_order_parts` |
| `0008-audits.sql` | `audits`, `audit_parts` |
| `0009-po-receiving.sql` | `serial_id_claims`, `purchase_order_expected_serials`; adds `received_quantity` to `purchase_order_lines`, close columns to `purchase_orders`; seeds label-size settings |
| `0010-batch-lifecycle.sql` | Adds lifecycle columns to `batches`, `prior_device_id` to `devices` |
| `0011-session-token-link.sql` | Adds `created_by_token` to `sessions` |
| `0012-audit-settlement.sql` | Rebuilds `device_parts` with extended removal CHECKs (`unavailable`, `audit`) |
| `0013-part-intake-source.sql` | Adds `intake_source` to `serialized_parts` (with backfill) |
| `0014-part-price-override.sql` | Adds nullable `price_cents` (the Part Price override) to `serialized_parts` |
| `0015-device-approval.sql` | Rebuilds `devices` with `Denied Repair` in the status CHECK and the nullable `approval_decision` / `approval_decision_note` columns (children carried through the rebuild) |
| `0016-buybacks.sql` | Adds `skus.buybackable`; rebuilds `serialized_parts` (status CHECK gains `buyback`) and `device_parts` (`removed_to` gains `buyback`) with their children carried through; creates `buyback_orders` / `buyback_order_parts` |
| `0017-price-add-limit.sql` | Adds `price_add_limit_cents` (NOT NULL DEFAULT 0) to `devices` |
| `0018-return-orders.sql` | Rebuilds `serialized_parts` (status CHECK gains `in_transit`, ticket 29) with its five children carried through; backfills parts attached to open RMA/buyback orders to `in_transit`; creates `return_orders` / `return_order_parts` |
| `0019-device-removal.sql` | Adds `removed_at` / `removed_by` / `removal_note` to `devices` (ticket 30: soft removal — listings filter `removed_at IS NULL`; the all-or-nothing pairing is enforced by the one removal writer, no CHECK) |
| `0020-device-number.sql` | Adds `devices.device_number` (NOT NULL via default-free ADD + domain-guaranteed assignment) — the stable per-batch human number, MAX+1 within the batch, never reused |
| `0021-consumable-removal.sql` | Adds nullable `removed_at` / `removed_by` / `removal_note` to `device_consumables` (cost correction: a usage is soft-removed and kept; Parts Cost sums only `removed_at IS NULL`; the all-or-nothing removal write is enforced in the domain — SQLite cannot ADD a CHECK via ALTER) |
| `0022-user-admin-role.sql` | Extends `users.role` CHECK with `admin` (rebuilds the table; ticket 18's admin surface) |
| `0023-skus-default-source-url.sql` | Adds nullable `skus.default_source_url` (ticket 11: the one free-text default source link) |
| `0028-sku-min-on-hand.sql` | Adds `skus.min_on_hand` (default 0, CHECK `>= 0` — the serialized SKU's minimum on-hand quantity; CONTEXT.md: Minimum On-hand) |
| `0024-devices-loc-bin.sql` | Adds nullable `devices.loc_bin` (ticket 08: the combined Loc/Bin location label) |
| `0025-audit-scheduled-at-backfill.sql` | Backfills `audits.scheduled_at` = `opened_at` for every existing audit (ticket 01: the cadence anchor swaps from `opened_at` to `scheduled_at` with zero behavior change) |
| `0026-audit-close-kind.sql` | Adds nullable `audits.close_kind` and backfills it for every already-closed audit from its outcome buckets (ticket 02: the close kind is computed, never declared) |
| `0027-buyback-order-value.sql` | Adds nullable `buyback_orders.order_value_cents` and backfills complete orders with the sum of their recorded sale prices; rebuilds `buyback_order_parts` without its settlement columns (buyback-order-value spec: the order settles for ONE hand-entered value) |

Migrations are additive and never renumbered; the runner refuses gaps,
renumbering, or a recorded migration missing from the directory.

---

## migrations (0001)

| Column | Type | Constraints |
| --- | --- | --- |
| `name` | TEXT | PRIMARY KEY |
| `applied_at` | TEXT | NOT NULL — stamped through the injectable clock |

Invariant: one row per applied migration file, name = file name. The admin
panel's system info and the restore validator read it; a restore whose applied
set is not a prefix of the server's known migrations is refused.

## users (0002)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `email` | TEXT | NOT NULL, UNIQUE |
| `role` | TEXT | NOT NULL, CHECK `role IN ('manager','tech')` |
| `active` | INTEGER | NOT NULL DEFAULT 1, CHECK `active IN (0,1)` |
| `created_at` | TEXT | NOT NULL |

Referenced by: `login_tokens`, `sessions`, `events` (nullable actor),
`device_models.created_by`, `batches.*_by`, `devices.assigned_tech_id`,
`device_parts.added_by/removed_by`, `device_consumables.recorded_by`,
`demand_records.created_by/fulfilled_by`, `purchase_orders.created_by/approved_by/closed_by`,
`purchase_order_tracking.added_by`, `rma_orders.created_by`,
`rma_order_parts.added_by`, `audits.opened_by/closed_by`.

Application invariants beyond the schema:

- Emails are allowlisted to the domains configured in `ALLOWED_EMAIL_DOMAINS` (the .env
  setting) at every write seam (user creation, login-link requests).
- The last active manager OR ADMIN can never be demoted or deactivated (409) —
  "manager powers" is one predicate (`hasManagerPowers`), and both roles count.
- Deactivation deletes the user's sessions in the same transaction — it takes
  effect immediately.
- There is no bootstrap manager: a fresh or wiped database has ZERO users, and
  the admin panel (key-gated) is the recovery path — its Users section creates
  users and mints their first login links.

## login_tokens (0002)

| Column | Type | Constraints |
| --- | --- | --- |
| `token` | TEXT | PRIMARY KEY (random 256-bit hex) |
| `user_id` | INTEGER | NOT NULL, FK → `users(id)` |
| `created_at` | TEXT | NOT NULL |
| `expires_at` | TEXT | NOT NULL |
| `used_at` | TEXT | nullable — set on redemption |

Invariants: single-use, 15-minute expiry, consumed in a transaction with the
session creation (a concurrent redemption cannot double-spend). A
re-presented used token is answered with success only when the presenting
session cookie is the session that token created (`sessions.created_by_token`).

## sessions (0002)

| Column | Type | Constraints |
| --- | --- | --- |
| `token` | TEXT | PRIMARY KEY |
| `user_id` | INTEGER | NOT NULL, FK → `users(id)` |
| `created_at` | TEXT | NOT NULL |
| `created_by_token` | TEXT | nullable (0011) — the login token that created the session |

Index: `sessions_user (user_id)`.

Invariants: no server-side expiry (the browser cookie caps at 400 days);
deleting the user's sessions on deactivation; the admin panel's sessions are
NOT here — they live in process memory only.

## events (0002)

The one timeline: typed notes and system events from every domain.

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY — insertion order is chronological order |
| `entity_type` | TEXT | NOT NULL (e.g. `user`, `batch`, `device`, `part`, `sku`, `po`, `rma`, `buyback`, `return`, `audit`, `demand`, `setting`, `model`) |
| `entity_id` | INTEGER | NOT NULL |
| `actor_id` | INTEGER | nullable, FK → `users(id)` — null when the system acts |
| `at` | TEXT | NOT NULL |
| `action` | TEXT | NOT NULL — `<entity>.<past-tense-verb>`; notes are `note.added` |
| `payload` | TEXT | nullable — JSON |

Index: `events_entity (entity_type, entity_id, id)`.

Invariants: append-only — no edit or delete path exists anywhere; every write
goes through `recordEvent`; a status change carries a note in its payload when one is given.

## skus (0003, altered 0023, altered 0028)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `name` | TEXT | NOT NULL |
| `price_cents` | INTEGER | NOT NULL, CHECK `price_cents >= 0` |
| `kind` | TEXT | NOT NULL, CHECK `kind IN ('serialized','consumable')` |
| `buybackable` | INTEGER | NOT NULL DEFAULT 0 (0016), CHECK `buybackable IN (0,1)` — CONTEXT.md: Buybackable, serialized SKUs only (domain-enforced) |
| `created_at` | TEXT | NOT NULL |
| `price_updated_at` | TEXT | NOT NULL — the date the price was last set or refreshed |
| `default_source_url` | TEXT | NULL (0023) — one free-text default source link per SKU (e.g. `source.com/part`); no URL validation at write time, no supplier entity (by design at this shop size) |
| `min_on_hand` | INTEGER | NOT NULL DEFAULT 0 (0028), CHECK `min_on_hand >= 0` — CONTEXT.md: Minimum On-hand; serialized SKUs only (domain-enforced at the write seams, like `buybackable`); 0 = no minimum |

Invariant: price staleness is derived, not stored — a SKU is stale when
`price_updated_at` + the `price_expiry_days` setting ≤ now. PO receipt
refreshes `price_cents`/`price_updated_at` to the line's unit cost (recorded
even when unchanged: the receipt confirms the price).

Invariants (ticket 11 / Minimum On-hand): `default_source_url` is a convenience prefill, never
a lock — new PO lines and Need to Order supplier fields pre-fill from it
and stay editable per line; the write seams accept any trimmed text ≤ 2000
chars ("" clears to NULL, the single representation of "none"), and whether
a stored value renders clickable is decided at READ time by the web's
shared strict URL detector (`web/src/sourceLink.ts`), never stored.

`min_on_hand` is serialized-only by domain enforcement (the write seams
refuse it on consumables and block a serialized → consumable kind change
while a minimum > 0 stands) and is a plain setting: no note required, a
change recorded as `sku.min_on_hand_changed`. On-hand is the one definition
in `server/domains/parts/stock.ts` — the SKU's count of Available
serialized_parts — shared by the SKU serialization and by the PO form's
below-minimum prompt (`GET /api/purchase-orders/demand` returns `lowStock`:
serialized SKUs with `min_on_hand > 0` whose on-hand count is below it, with
the shortfall). The prompt is computed at read time and carries no lifecycle:
unlike demand records it is not marked ordered or fulfilled — receiving
stock is what makes the row disappear.

## serialized_parts (0003, altered 0013, altered 0014)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY — also the serial number |
| `sku_id` | INTEGER | NOT NULL, FK → `skus(id)` |
| `serial` | TEXT | NOT NULL, UNIQUE — `P` + zero-padded id (e.g. `P00001`) |
| `status` | TEXT | NOT NULL, CHECK `status IN ('available','reserved','unavailable','rma','damaged_by_tech','buyback','in_transit')` (0016 added `buyback`, 0018 added `in_transit`, each via the table rebuild) |
| `last_counted_at` | TEXT | nullable — refreshed by every scan (audit, cycle count, confirmed migration intake) |
| `created_at` | TEXT | NOT NULL |
| `intake_source` | TEXT | nullable in schema (0013), CHECK `intake_source IN ('purchase-order','migration','salvage')` |
| `price_cents` | INTEGER | nullable (0014), CHECK `price_cents IS NULL OR price_cents >= 0` — the part's own price override; NULL = use the SKU's current price |

Index: `serialized_parts_sku (sku_id)`.

Application invariants beyond the schema:

- `status` is written ONLY through `parts/status.ts` (guarded primitives and
  `changePartStatus`) — see the transition rules in docs/logic-map.md. A part
  becomes Reserved only through a batch reservation; the bare endpoint refuses
  both making a part Reserved and moving a Reserved part; the Reserved-leaving
  primitive (`movePartFromReserved`) additionally enforces the buybackable
  rule for the Buyback destination (CONTEXT.md: Buybackable), so no caller —
  removal, swap, or the batch close settlement — can bypass it.
- `intake_source` is nullable only as a schema artifact (SQLite cannot ADD a
  NOT NULL column portably): both intake seams (`parts/intake.ts`,
  PO receiving) always set it, and the expense report throws loudly on a NULL
  rather than guessing. A NULL means a writer bypassed both seams.
- A part row is born in exactly two places: `parts/intake.ts` (migration,
  salvage) and PO receipt — both stamp the intake source.
- A part can sit on only one OPEN outbound order at a time — RMA, buyback, or
  return (enforced in each scan transaction; ticket 29 makes it structural:
  a scanned part carries the `in_transit` status, which is neither Available
  nor RMA nor Buyback, so no second order can take it).
- **Part Price (0014, ticket 23).** `price_cents` is the part's own price
  override; NULL means "use the SKU's current price". The effective price —
  override ?? SKU price — is resolved in exactly one place:
  `parts/effective-price.ts`. The column is stamped at birth by both intake
  doors (intake takes an optional price; PO receipt stamps the received unit
  cost) and afterwards written ONLY by `setPartPrice` (the part-detail
  re-price door: note required, `part.price_changed` event) and by the batch
  add-part flow (an explicitly priced add stamps the reserved unit). While a
  part is unattached or its active attachment's batch is Awaiting approval,
  any user may set or change the price; on an Open batch it is manager-only
  through the amendment flow; on a Closed batch it cannot change. The active
  `device_parts` attachment's snapshot is kept equal to the effective price
  (see `device_parts` below), so Parts Cost and the approval total move with
  a legitimate price change and never with an illicit one.
- **Buyback (0016, ticket 27).** The status vocabulary gained `buyback`
  (CONTEXT.md: Buyback) via the 0016 table rebuild — the CHECK could not be
  altered, and serialized_parts is a parent table, so the rebuild cascaded
  through device_parts, rma_order_parts, audit_parts and
  purchase_order_expected_serials with foreign keys enforced (no rows
  changed). A part enters Buyback only from a **Buybackable** SKU (enforced
  in `parts/status.ts`); a part attached to an in-transit buyback order
  refuses every bare status change, exactly like RMA.
- **In-Transit (0018, ticket 29).** The status vocabulary gained `in_transit`
  (CONTEXT.md: In-Transit) via a second full cascade rebuild — this one also
  carrying `buyback_order_parts` through. The invariant the domains maintain:
  `status = 'in_transit'` ⟺ the part is attached to an OPEN (in-transit)
  order in exactly one of `rma_order_parts` / `buyback_order_parts` /
  `return_order_parts`. Only the order domains write it — an order's scan
  (from Available/RMA/Buyback) and its Complete (to Unavailable), both through
  `changePartStatus`; the bare endpoint refuses either direction, and
  `changePartStatus` THROWS on the inconsistency of an in_transit part no
  open order claims. 0018 backfilled existing attached parts to satisfy it.

## app_settings (0003, seeded 0003 + 0009)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `key` | TEXT | NOT NULL, UNIQUE |
| `value` | TEXT | NOT NULL |

Seeded keys and defaults: `price_expiry_days` = 90, `audit_interval_months` = 2,
`label_width_sixteenths` = 37 (2-5/16″), `label_height_sixteenths` = 64 (4″).
Ticket 19 adds the text-typed setting `dymo_printer_name` (default empty, max
200 characters) — no migration: the row is created on first write, and reads
fall back to the empty default. Invariants: int settings are whole numbers
validated against per-key definitions at every write seam (manager route and
admin route share one validator); a stored value that fails its definition
throws loudly when read instead of degrading to a default. The text setting
is trimmed, capped at its max length, and an empty value is a legitimate
"not chosen yet" state.

## device_models (0004)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `name` | TEXT | NOT NULL, UNIQUE |
| `created_at` | TEXT | NOT NULL |
| `created_by` | INTEGER | nullable, FK → `users(id)` |

Invariant: models are never edited or removed — only added; a case-insensitive
name match returns the existing row instead of creating a near-duplicate.

## batches (0004, altered 0010)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `number` | INTEGER | NOT NULL, UNIQUE — the human-facing sequential number |
| `created_at` | TEXT | NOT NULL |
| `created_by` | INTEGER | NOT NULL, FK → `users(id)` |
| `status` | TEXT | NOT NULL DEFAULT 'Awaiting approval' (0010), CHECK `status IN ('Awaiting approval','Open','Closed')` |
| `approved_at` | TEXT | nullable (0010) |
| `approved_by` | INTEGER | nullable, FK → `users(id)` (0010) |
| `approved_cost_cents` | INTEGER | nullable (0010) — the Parts Cost total the manager signed off |
| `closed_at` | TEXT | nullable (0010) |
| `closed_by` | INTEGER | nullable, FK → `users(id)` (0010) |

Invariant: `status` is written only by the batches domain's own lifecycle
functions (approve / close), never by hand and never from another domain's
write path. There is deliberately no per-batch device-count column — device
counts are computed by GROUP BY at read time. There is deliberately no
opening-note column either: the note captured at creation lives as the
batch's FIRST `note.added` event (written by `createBatchRecord` inside the
creation transaction, before the batch id can be referenced by anything
else), and batch serialization reads it back from there.

## devices (0004, altered 0010, rebuilt 0015, altered 0024)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `batch_id` | INTEGER | NOT NULL, FK → `batches(id)` |
| `model_id` | INTEGER | NOT NULL, FK → `device_models(id)` |
| `capacity` | TEXT | nullable |
| `asset_id` | TEXT | nullable |
| `imei` | TEXT | nullable |
| `serial_number` | TEXT | nullable |
| `loc_bin` | TEXT | nullable (0024) — the combined Loc/Bin: one optional free-text location label ("Shelf 3 / Bin B"), never two fields |
| `stated_issue` | TEXT | NOT NULL |
| `notes` | TEXT | nullable |
| `repair_time_minutes` | INTEGER | nullable, CHECK `repair_time_minutes IS NULL OR repair_time_minutes >= 0` |
| `repair_status` | TEXT | NOT NULL DEFAULT 'Awaiting repair', CHECK `repair_status IN ('Awaiting repair','In progress','QA','Parts needed','Repaired','Unrepairable','Additional issues present','Denied Repair')` (0015) |
| `resolution_notes` | TEXT | nullable - optional when a device reaches a terminal status through the status graph (the status change itself is the record; when given, the notes say how the repair ended; Denied Repair's resolution notes are the rejection's optional note) |
| `assigned_tech_id` | INTEGER | NOT NULL, FK → `users(id)` |
| `triage_date` | TEXT | NOT NULL — auto-set at creation, never client-supplied |
| `prior_device_id` | INTEGER | nullable, self-FK → `devices(id)` (0010) — the retriage chain |
| `approval_decision` | TEXT | nullable (0015), CHECK `approval_decision IN ('approved','rejected')` — the manager's per-device decision while the batch is Awaiting approval |
| `approval_decision_note` | TEXT | nullable (0015) — optional for either decision; when present on a rejection it becomes the Denied Repair resolution notes |
| `price_add_limit_cents` | INTEGER | NOT NULL DEFAULT 0 (0017), CHECK `>= 0` — the Price Add Limit: the post-approval spend a tech may add without further approval; 0 = no headroom (the pre-ticket behavior) |
| `created_at` | TEXT | NOT NULL |
| `updated_at` | TEXT | NOT NULL |

Indexes: `devices_batch (batch_id)`, `devices_model (model_id)`,
`devices_assigned_tech (assigned_tech_id)`, `devices_imei (imei)`,
`devices_asset_id (asset_id)`, `devices_serial_number (serial_number)`,
`devices_prior (prior_device_id)` (0010).

Application invariants beyond the schema:

- At least one of `imei` / `asset_id` / `serial_number` must be non-null —
  enforced in the domain (each is optional individually; a CHECK cannot express
  "together ≥ 1" cleanly, and duplicates are allowed with only a warning, so no
  UNIQUE index exists on them by design).
- `loc_bin` (0024) is CURRENT STATE, not history: the device moves around the
  shop, so an edit overwrites the column in place and writes NO timeline
  event — the devices domain deliberately leaves it out of the edit route's
  `device.edited` payload (a loc/bin-only edit records nothing at all). Any
  tech may edit it, no note required; the device row renders an unset value
  as "—", never a silent blank. Device search matches it as a substring.
- `repair_status` is written only by `setRepairStatus` (graph-checked,
  approval-gated, event-recording) — there is one exception by design:
  `approveBatch` writes **Denied Repair** directly inside the approval
  transaction, because Denied Repair is reachable ONLY through the manager's
  per-device rejection and no graph edge targets it. The CHECK and the
  domain vocabulary were extended by the 0015 table rebuild (SQLite cannot
  ALTER a CHECK; devices is a parent table, so the rebuild cascades through
  its three child tables with foreign keys enforced).
- **Terminal Repair Statuses are close-eligible, not absorbing**: Repaired,
  Unrepairable, Additional issues present, and Denied Repair end the
  device's run (they satisfy the close guard and freeze the device's parts),
  but each carries graph exits (In progress / QA; Repaired and Denied Repair
  also → Awaiting repair) so an accidental set can be corrected — any user,
  through the status endpoint, evented like any transition. An exit does NOT
  undo the status's side effects: the retriage's continuation row and the
  denial's part return stand; the timeline tells the story.
- `approval_decision` is written only by `decideDeviceApproval` and the bulk
  `approveAllDevices` (the batch page's "Approve all devices": approves every
  UNDECIDED device in one transaction, same manager-only /
  Awaiting-approval-only rules — decided devices, rejected ones included,
  are never touched) —
  manager-only, Awaiting-approval-only, re-togglable until the batch opens
  (the latest decision wins; every decision is a `device.approval_decided`
  event). Batch approval requires every device decided (undecided devices
  are refused by name); rejected devices end in Denied Repair with their
  active parts returned to stock, and the approved cost covers approved
  devices only (both at sign-off and at any later amendment).
- **Price Add Limit (0017, ticket 28).** Set with the approval decision
  (omitted keeps the standing value) and changeable later in place only by a
  manager (`changeDevicePriceLimit`, `device.price_limit_changed` old → new;
  refused on a Closed batch). The spend it caps is DERIVED, never stored:
  `devicePostApprovalSpendCents` = the snapshot-cost sum of the device's
  ACTIVE attachments created strictly after the batch's `approved_at`, plus
  consumable usage recorded after it — pre-approval additions are covered by
  the approved total and never count, a swap's removed attachment drops out
  while its replacement counts, and price overrides count at their effective
  price. On an Open batch the batchparts add/consumable endpoints refuse a
  tech's addition when `spend + addition > limit` (equal allowed); managers
  bypass, and the refusal names the limit, the spend, the cost, and the
  options (manager override / retriage / Unrepairable). A retriaged
  continuation row starts at the DEFAULT limit (0) — a new batch is a new
  approval cycle.
- Retriage: the row a device continues (`prior_device_id`) plus the identifier
  columns are what cross-batch device history matches on. The retriage INSERT
  does not copy the approval columns — the new batch runs its own approval.

## device_parts (0005, rebuilt 0012)

One serialized part attached to one device row on a batch.

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `device_id` | INTEGER | NOT NULL, FK → `devices(id)` |
| `part_id` | INTEGER | NOT NULL, FK → `serialized_parts(id)` |
| `price_cents` | INTEGER | NOT NULL, CHECK `price_cents >= 0` — the part's EFFECTIVE price (its own override ?? its SKU's price) snapshotted at reservation time |
| `added_at` | TEXT | NOT NULL |
| `added_by` | INTEGER | NOT NULL, FK → `users(id)` |
| `removed_at` | TEXT | nullable |
| `removed_by` | INTEGER | nullable, FK → `users(id)` |
| `removed_to` | TEXT | nullable, CHECK `removed_to IN ('available','rma','damaged_by_tech','unavailable','buyback')` (0012, 0016) |
| `removal_note` | TEXT | nullable |
| `removal_reason` | TEXT | nullable, CHECK `removal_reason IN ('removal','swap','audit')` (extended by 0012) |

Table CHECK: the removal record is all-or-nothing — either every removal column
is NULL (active attachment) or every one is NOT NULL (ended attachment); a
half-filled removal is refused by the schema itself.

Indexes: `device_parts_device (device_id)`, `device_parts_part (part_id)`,
and the partial unique index
`device_parts_active_part (part_id) WHERE removed_at IS NULL` — **a part is
attached to at most one device at a time** (portable: supported by SQLite and
Postgres alike).

Application invariants beyond the schema:

- Removal is never silent: whoever removes records when / who / where the part
  went / why (note, required) / the kind of removal.
- `removal_reason = 'audit'` with `removed_to = 'unavailable'` is written only
  by the audit-close settlement, through the batchparts seam.
- Parts Cost is COMPUTED from this table plus `device_consumables`
  (`SUM(price_cents)` over active attachments) — never stored as a hand-entered
  column. The snapshot keeps a device's cost stable against later catalog
  price changes, so approval signs off a number that will not move.
- The snapshot starts as the part's effective price at reservation (ticket 23)
  and is afterwards kept equal to it by `setPartPrice` while the attachment is
  active — an approved price change is a legitimate, amended cost change, so
  the snapshot follows; nothing else rewrites it.

## device_consumables (0005)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `device_id` | INTEGER | NOT NULL, FK → `devices(id)` |
| `sku_id` | INTEGER | NOT NULL, FK → `skus(id)` |
| `quantity` | INTEGER | NOT NULL, CHECK `quantity > 0` |
| `unit_price_cents` | INTEGER | NOT NULL, CHECK `unit_price_cents >= 0` — snapshotted at recording time |
| `recorded_at` | TEXT | NOT NULL |
| `recorded_by` | INTEGER | NOT NULL, FK → `users(id)` |
| `removed_at` | TEXT | nullable (0021) — the cost-correction removal; NULL = active |
| `removed_by` | INTEGER | nullable (0021), FK → `users(id)` |
| `removal_note` | TEXT | nullable (0021) — required by the domain on removal |

Indexes: `device_consumables_device (device_id)`, `device_consumables_sku (sku_id)`.

Invariant: consumables are cost-only — no serialized stock rows, no counting,
no audit (CONTEXT.md). A consumable SKU can never be reserved or scanned.
A removed usage is a cost correction, never a deletion: the row keeps
when/who/why, Parts Cost sums only `removed_at IS NULL`, and the timeline
records both the usage and its removal
(`device.consumable_used` / `device.consumable_removed`). The expense report
does NOT read this table — consumables are expensed at PO receipt (the
receipt events), so usage would double-count.

## demand_records (0005)

A Need to Order record: a SKU with insufficient Available stock, tied to the
Batch that needs it. Not a physical part and not a part status.

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `sku_id` | INTEGER | NOT NULL, FK → `skus(id)` |
| `batch_id` | INTEGER | NOT NULL, FK → `batches(id)` |
| `device_id` | INTEGER | nullable, FK → `devices(id)` |
| `supplier` | TEXT | nullable — the optional supplier link |
| `status` | TEXT | NOT NULL DEFAULT 'open', CHECK `status IN ('open','fulfilled')` |
| `created_at` | TEXT | NOT NULL |
| `created_by` | INTEGER | NOT NULL, FK → `users(id)` |
| `fulfilled_at` | TEXT | nullable |
| `fulfilled_by` | INTEGER | nullable, FK → `users(id)` |

Indexes: `demand_records_batch (batch_id)`, `demand_records_sku (sku_id)`,
`demand_records_open (status)`.

Invariants: created only by the batchparts add-part path when stock is short;
fulfilled only by an arriving part — a PO receipt or a salvage/migration
intake (ticket 10), one part per record, guarded
`UPDATE … WHERE status = 'open'`; fulfillment carries one status consequence —
the demanding device's LAST open record fulfilled auto-returns it from
Parts needed to Awaiting repair through `setRepairStatus`
(`batches/lifecycle.ts autoUnblockAfterDemandFulfilled`, called by both
arrival doors); a PO referencing a demand marks it ordered
in the purchaseorders domain's OWN link table (`purchase_order_demand`) —
ordering is not fulfilling; open demands follow their device across a retriage,
fulfilled ones stay put as history.

## purchase_orders (0006, altered 0009)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `number` | INTEGER | NOT NULL, UNIQUE — sequential human number |
| `purpose` | TEXT | NOT NULL |
| `sources` | TEXT | nullable — free text, suggested from history, never a dropdown |
| `shipping_cost_cents` | INTEGER | NOT NULL DEFAULT 0, CHECK `shipping_cost_cents >= 0` |
| `status` | TEXT | NOT NULL DEFAULT 'Awaiting approval', CHECK `status IN ('Awaiting approval','In-transit','Partially received','Received','Closed')` |
| `created_at` | TEXT | NOT NULL |
| `created_by` | INTEGER | NOT NULL, FK → `users(id)` |
| `approved_at` | TEXT | nullable |
| `approved_by` | INTEGER | nullable, FK → `users(id)` |
| `closed_at` | TEXT | nullable (0009) |
| `closed_by` | INTEGER | nullable, FK → `users(id)` (0009) |
| `closed_note` | TEXT | nullable (0009) — the shortfall note |

Index: `purchase_orders_status (status)`.

Invariant: `Partially received` / `Received` are derived from line received
quantities, never hand-set; the only explicit status writes after In-transit
are the derived recompute and the shortfall close.

Shipping cost (`shipping_cost_cents`) is set at creation (omitted → 0) and a
manager sets it via `POST /api/purchase-orders/:id/shipping-cost` (optional
note) in any status except Closed. The write is one `UPDATE` plus one
`po.shipping_changed` timeline event (old → new, plus the note when given); the PO total and
expense reporting both read this column, so there is no parallel number to
keep in sync.

While the PO is Awaiting approval the paperwork is revisable: the line set
can be REPLACED via `POST /api/purchase-orders/:id/lines` (same line schema
as creation + optional note; one `po.lines_changed` event) and the whole
draft can be HARD-deleted via `DELETE /api/purchase-orders/:id` — demand
links, lines, tracking, the PO's `events` rows, and the row itself, one
transaction. No soft "voided" status exists: a deleted draft leaves no
trace, and its sequential number is reusable (numbers are MAX+1 labels, not
a gapless ledger). Approval freezes the paperwork — after it, shipping cost
is the only field with an edit path.

## purchase_order_lines (0006, altered 0009)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `po_id` | INTEGER | NOT NULL, FK → `purchase_orders(id)` |
| `sku_id` | INTEGER | NOT NULL, FK → `skus(id)` |
| `quantity` | INTEGER | NOT NULL, CHECK `quantity >= 1` |
| `unit_price_cents` | INTEGER | NOT NULL, CHECK `unit_price_cents >= 0` — what was actually agreed; the catalog price is only the form's default |
| `source` | TEXT | nullable — the vendor for THIS line, pre-filled from a demand record's supplier link |
| `demand_id` | INTEGER | nullable — deliberately NO foreign key: this is a decoupling choice, not a stepped-database guard — see `purchase_order_demand` below |
| `created_at` | TEXT | NOT NULL |
| `received_quantity` | INTEGER | NOT NULL DEFAULT 0 (0009), CHECK `received_quantity >= 0` |

Indexes: `purchase_order_lines_po (po_id)`, `purchase_order_lines_sku (sku_id)`.

## purchase_order_tracking (0006)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `po_id` | INTEGER | NOT NULL, FK → `purchase_orders(id)` |
| `carrier` | TEXT | NOT NULL |
| `tracking_number` | TEXT | NOT NULL |
| `added_at` | TEXT | NOT NULL |
| `added_by` | INTEGER | NOT NULL, FK → `users(id)` |

Index: `purchase_order_tracking_po (po_id)`. Append-only — multiple entries per
PO, never edited or removed.

## purchase_order_demand (0006)

The purchaseorders domain's own record of which demand records have been
marked ordered; outstanding demand = open `demand_records` minus these ids.

A pre-approval line revision (`POST /api/purchase-orders/:id/lines`)
RE-DERIVES this table's rows for the PO: a previously-linked demand stays
linked while its record is open AND its SKU still has a line in the new set;
explicit demand refs on the submitted lines mark new records ordered;
everything else is released (row deleted) and returns to the outstanding
queue. The link table is PO-grain — only each line's FIRST demand ref is
stored on `purchase_order_lines.demand_id` — so per-line demand sets cannot
round-trip; the SKU-based rule is derivable server-side instead.

A shortfall close (`POST /api/purchase-orders/:id/close`) deletes EVERY link
row for the PO: the still-open demands return to the outstanding queue
automatically (outstanding = open records minus link ids — no
`demand_records` write), and the close event names the released ids
(`demandReleased`). The PO is terminal, so nothing re-marks them.

| Column | Type | Constraints |
| --- | --- | --- |
| `po_id` | INTEGER | NOT NULL, FK → `purchase_orders(id)` |
| `demand_id` | INTEGER | NOT NULL — deliberately NO foreign key: the migration runner applies 0005 before 0006 in every database the app opens, so the old "stepped database" rationale is refuted (ticket 15). The missing FK is a deliberate decoupling: the link table records cross-domain facts by id without schema-level dependency between the domains |
| `marked_at` | TEXT | NOT NULL |

Constraint: `UNIQUE (po_id, demand_id)` — the portable upsert deduplicates
repeated demand references within one PO.
Index: `purchase_order_demand_demand (demand_id)`.

## rma_orders (0007)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `number` | INTEGER | NOT NULL, UNIQUE — sequential human number |
| `status` | TEXT | NOT NULL, CHECK `status IN ('in_transit','complete')` |
| `created_at` | TEXT | NOT NULL |
| `created_by` | INTEGER | NOT NULL, FK → `users(id)` |
| `completed_at` | TEXT | nullable — set only by the Complete flow |

Index: `rma_orders_completed (completed_at)` — the recovery report's interval
scan.

## rma_order_parts (0007)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `rma_order_id` | INTEGER | NOT NULL, FK → `rma_orders(id)` |
| `part_id` | INTEGER | NOT NULL, FK → `serialized_parts(id)` |
| `added_at` | TEXT | NOT NULL |
| `added_by` | INTEGER | NOT NULL, FK → `users(id)` |
| `disposition` | TEXT | nullable, CHECK `disposition IS NULL OR disposition IN ('credited','rejected')` |
| `credit_cents` | INTEGER | nullable, CHECK `credit_cents IS NULL OR credit_cents >= 0` |
| `disposition_note` | TEXT | nullable |
| `settled_at` | TEXT | nullable |

Table CHECK: `disposition IS NULL OR (disposition_note IS NOT NULL AND
(disposition = 'rejected' OR credit_cents IS NOT NULL))` — a settled row always
carries its note, and a credited part always carries its value.

Indexes: `rma_order_parts_order (rma_order_id)`, `rma_order_parts_part (part_id)`.

Invariants: a part can sit on only one OPEN order at a time (enforced in the
scan transaction); the settled row stays forever as the recovery record; the
settlement columns are written only by the Complete flow.

## buyback_orders (0016; order_value_cents 0027)

The ticket-27 mirror of `rma_orders` — the shipment that earns money.

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `number` | INTEGER | NOT NULL, UNIQUE — sequential human number |
| `status` | TEXT | NOT NULL, CHECK `status IN ('in_transit','complete')` |
| `created_at` | TEXT | NOT NULL |
| `created_by` | INTEGER | NOT NULL, FK → `users(id)` |
| `completed_at` | TEXT | nullable — set only by the Complete flow |
| `order_value_cents` | INTEGER | nullable (0027) — the ONE hand-entered order value, set only by Complete; NULL while open. Non-negative is domain-guaranteed at the single write site (SQLite cannot ADD a CHECK via ALTER, the 0021/0026 pattern); 0027 backfilled complete orders with the sum of their recorded sale prices |

Index: `buyback_orders_completed (completed_at)` — the buyback-recovery
report's interval scan.

## buyback_order_parts (0016; rebuilt by 0027)

The ATTACHMENT record — which parts shipped on which order. Since 0027 it
carries no settlement columns: a buyback order settles for ONE hand-entered
value on the order, not a disposition and price per part.

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `buyback_order_id` | INTEGER | NOT NULL, FK → `buyback_orders(id)` |
| `part_id` | INTEGER | NOT NULL, FK → `serialized_parts(id)` |
| `added_at` | TEXT | NOT NULL |
| `added_by` | INTEGER | NOT NULL, FK → `users(id)` |

Indexes: `buyback_order_parts_order (buyback_order_id)`,
`buyback_order_parts_part (part_id)`.

Invariants: one open order per part (enforced in the scan transaction); the
rows stay forever as the shipment record, while the revenue lives on the
order (`order_value_cents`); Complete settles every part Unavailable through
the part-status module and is the only writer of the order's settlement
columns.

## return_orders (0018)

The ticket-29 Return Order — an Available-parts shipment whose revenue is
BOOKED at completion, not entered by hand.

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `number` | INTEGER | NOT NULL, UNIQUE — sequential human number, its own number space |
| `status` | TEXT | NOT NULL, CHECK `status IN ('in_transit','complete')` |
| `created_at` | TEXT | NOT NULL |
| `created_by` | INTEGER | NOT NULL, FK → `users(id)` |
| `completed_at` | TEXT | nullable — set only by the Complete flow |

Index: `return_orders_completed (completed_at)` — the returns-revenue
report's interval scan.

## return_order_parts (0018)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `return_order_id` | INTEGER | NOT NULL, FK → `return_orders(id)` |
| `part_id` | INTEGER | NOT NULL, FK → `serialized_parts(id)` |
| `added_at` | TEXT | NOT NULL |
| `added_by` | INTEGER | NOT NULL, FK → `users(id)` |
| `price_cents` | INTEGER | nullable, CHECK `price_cents IS NULL OR price_cents >= 0` |
| `settled_at` | TEXT | nullable |

Table CHECK: `(price_cents IS NULL) = (settled_at IS NULL)` — the revenue
snapshot and the settlement stamp land together, never one without the
other.

Indexes: `return_order_parts_order (return_order_id)`,
`return_order_parts_part (part_id)`.

Invariants: one open order per part (structural since ticket 29 — an
in-transit part is not Available, so no second order can claim it);
`price_cents` snapshots the part's EFFECTIVE price (override ?? SKU) at
Complete and is never rewritten afterwards; the settlement is written only
by the Complete flow, which settles every part Unavailable through the
part-status module.

## audits (0008)

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `scheduled_at` | TEXT | nullable — the audit_interval_months boundary that triggered the audit (ticket 01: the cadence anchor). NULL when no boundary did: the bootstrap audit (the only manual open left, ticket 02 — a manager's one-time open on a system with no audits) |
| `opened_at` | TEXT | NOT NULL — the factual moment the window actually opened (lazy auto-opens land at the first request after the boundary, ADR-0002) |
| `opened_by` | INTEGER | NOT NULL, FK → `users(id)` — on an auto-opened window, the user whose request triggered the lazy transition |
| `closed_at` | TEXT | nullable — NULL while the window is open |
| `closed_by` | INTEGER | nullable, FK → `users(id)` — the manager on a manual close; **NULL means the system auto-closed the window at its boundary** (ticket 02, ADR-0002) |
| `close_kind` | TEXT | nullable (0026) — stamped at close by the one close core; NULL while the window is open. CHECK vocabulary `complete` / `shortfall` is domain-guaranteed (SQLite cannot ADD a CHECK via ALTER, the 0021 pattern) |
| `previous_audit_id` | INTEGER | nullable, self-FK → `audits(id)` |
| `anchor_at` | TEXT | nullable — end of the previous audit's open DAY (UTC); NULL on the first audit, meaning everything in circulation is due |

Index: `audits_opened (opened_at)`.

Invariants: at most one open window (checked at open, not by an index — the
lazy boundary processor closes-and-opens in ONE transaction, so the
transition itself preserves it); the due list is computed at OPEN time and
snapshotted into `audit_parts`, so a part added while the window is open is
never demanded by that audit; the cadence anchors on the last audit's
`scheduled_at` — the boundary that triggered it — never on the actual open
moment, which would drift the schedule once windows open lazily (ADR-0002);
an audit with `scheduled_at` NULL (the bootstrap audit) anchors the cadence
on its own `opened_at`, and 0025 backfilled every pre-lifecycle audit's
`scheduled_at` to its `opened_at` so the anchor swap changed no derived
boundary. `close_kind` is COMPUTED from the outcome buckets, never declared:
any `failed` outcome (a due part that did not survive the audit) means
`shortfall`, otherwise `complete` — the buckets are the evidence, for
manager closes and boundary auto-closes alike, so a "clean" close with
remaining due parts is unrecordable (ticket 02); 0026 backfilled every
already-closed audit the same way. `closed_by` NULL + the actor-less
`audit.closed` event (`auto: true`, the boundary, and the missed-boundary
count) is the auto-close record; `opened_by` on an auto-opened window is
the user whose request happened to trigger it — the request's timing, not
a decision by them.

## audit_parts (0008)

| Column | Type | Constraints |
| --- | --- | --- |
| `audit_id` | INTEGER | NOT NULL, FK → `audits(id)` — part of the composite primary key |
| `part_id` | INTEGER | NOT NULL, FK → `serialized_parts(id)` — part of the composite primary key |
| `outcome` | TEXT | nullable, CHECK `outcome IS NULL OR outcome IN ('counted','failed','moved')` |

Primary key: `(audit_id, part_id)`. Index: `audit_parts_part (part_id)`.

Invariant: `outcome` is NULL while the window is open and stamped only at
close: `counted` (scanned during the window), `failed` (due-but-unscanned and
still in circulation — the part became Unavailable), or `moved` (accounted for
mid-window by a user's status change).

## serial_id_claims (0009)

Claimed serial ids that are not yet rows in `serialized_parts` — the parts
domain's allocation registry so ad-hoc intake and PO pre-assignment cannot
collide on the same barcode.

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY — equals the future `serialized_parts.id` |
| `serial` | TEXT | NOT NULL, UNIQUE |
| `claimed_at` | TEXT | NOT NULL |

Invariant: a claim lives until the matching part row exists — PO receipt
consumes it (delete + insert in one transaction); intake occupies the id
directly. `nextPartId` = max(parts.id, claims.id) + 1.

## purchase_order_expected_serials (0009)

One row per expected physical unit on a PO line; `id` equals the future
`serialized_parts.id` (and `serial_id_claims.id`) so the barcode is stable from
print through receive.

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | INTEGER | PRIMARY KEY |
| `line_id` | INTEGER | NOT NULL, FK → `purchase_order_lines(id)` |
| `serial` | TEXT | NOT NULL, UNIQUE |
| `part_id` | INTEGER | nullable, FK → `serialized_parts(id)` — set when the scan creates the part |
| `received_at` | TEXT | nullable |
| `received_by` | INTEGER | nullable, FK → `users(id)` |

Table CHECK: `(part_id IS NULL AND received_at IS NULL AND received_by IS NULL)
OR (part_id IS NOT NULL AND received_at IS NOT NULL AND received_by IS NOT
NULL)` — receipt is all-or-nothing.

Indexes: `purchase_order_expected_serials_line (line_id)`,
`purchase_order_expected_serials_serial (serial)`.

---

## Invariants the schema alone does not carry

These are enforced by application code (the seams listed in
docs/logic-map.md), not by CHECK constraints:

1. **Reservation only through batches.** `serialized_parts.status = 'reserved'`
   is reachable only via `parts/status.ts` `reservePart`, which batchparts
   always pairs with a `device_parts` attachment inside one transaction; the
   bare status endpoint refuses to set or move Reserved.
2. **One active attachment per part.** Partial unique index (schema), plus the
   all-or-nothing removal CHECK (schema), plus "never a silent return to stock"
   (application).
3. **Money is integer cents.** Schema CHECKs bound every `*_cents` column at 0;
   `parsePriceToCents` refuses inputs with more than two decimal places;
   `formatCents` is the only dollars formatting, at the API edges.
4. **Intake source is always set.** The column is nullable (SQLite cannot add
   NOT NULL portably); the two intake seams always set it; the reports throw on
   a NULL instead of guessing; a NULL is a loud data defect, not a silently
   guessed source.
5. **Parts Cost is computed, never stored.** `SUM` over active
   `device_parts.price_cents` plus `device_consumables` quantity × unit price.
   The only stored number is `batches.approved_cost_cents` — the manager's
   signed-off total at approval, amended on post-approval part changes
   (a removal amends too, whatever the role — it only ever reduces cost,
   tickets 30 + 02; approved cost never goes stale on a removal) and on
   auto-reserved arrivals: a PO receipt (and, from ticket 10, an intake)
   satisfying a Need to Order demand amends the total in place to the
   part's actual price — the demand was the approval-time intent, the
   arrival makes it real — recorded by note; a Closed batch refuses the
   reservation instead (nothing attaches, nothing amends).
6. **Status columns have exactly one writer each.** `devices.repair_status` →
   `batches/lifecycle.ts setRepairStatus`; `serialized_parts.status` →
   `parts/status.ts`; `batches.status` → the batches lifecycle functions;
   `purchase_orders.status` → approve, the derived receiving recompute, and the
   shortfall close; `rma_orders.status`, `buyback_orders.status`, and
   `return_orders.status` → each domain's Complete flow; the in_transit
   ⇔ attached-to-an-open-order pairing of `serialized_parts.status` is
   maintained only by the order domains' scan/Complete (ticket 29).
7. **Every removal carries a note** (required at every endpoint), recorded as
   an event on the immutable timeline. Status-change notes are required only
   where a domain states it (a part status change, a PO close with
   shortfall, RMA/return/buyback completion); elsewhere they are optional,
   and a noteless change records no note in its event payload.
8. **Single open audit window**, the due list is snapshotted at open, and the
   cadence is derived, not stored: next boundary = the last audit's
   `scheduled_at` + `audit_interval_months` (`opened_at` when no boundary
   triggered it — the bootstrap audit; 0025 backfilled every pre-lifecycle
   audit's `scheduled_at` to its `opened_at`, so the anchor swap changed no
   derived boundary). The lifecycle is automatic (ticket 02, ADR-0002): any
   authenticated audits-domain request first runs the lazy boundary
   processor, which settles an open window whose boundary has passed
   (`closed_by` NULL, computed `close_kind`) and opens the next window from
   the LATEST missed boundary — several missed boundaries collapse into one
   settlement and one new window, and no window is ever backdated to a
   boundary instant. `close_kind` is stamped at close by the one close core
   and is computed from the buckets (any `failed` outcome → `shortfall`),
   never declared; 0026 backfilled closed audits the same way.
9. **Serial allocation is collision-free** across intake and PO
   pre-assignment via `serial_id_claims`.
10. **The last active manager is protected** against demotion and deactivation.
11. **Sequential human numbers** (`batches.number`, `purchase_orders.number`,
    `rma_orders.number`, `buyback_orders.number`, `return_orders.number`) via `MAX(number) + 1` inside the creating transaction;
    the five number spaces are independent.
12. **Danger rules in the admin panel**: every destructive action (clear,
    restore swap, write-mode SQL) backs up first, requires a typed
    confirmation, and is console-logged with a timestamp.
