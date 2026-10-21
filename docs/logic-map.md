# Logic map

One section per domain: what it is for, its routes, its state machines. Then the
cross-domain reads/writes matrix — which domain touches which OTHER domain's
tables, through what contract — and the shared infrastructure every domain
builds on.

Everything here is derived from the code (`server/domains/`, `server/db/migrations/`,
`server/bootstrap.ts`); the migration that creates each table is named in
[docs/data-model.md](data-model.md). Vocabulary is [CONTEXT.md](../CONTEXT.md).

How to read this document: each domain section stands alone. To change one
domain without reading the others, read its section plus the **Cross-domain
matrix** entry for anything it borrows, plus **Shared infrastructure** for the
seams it sits on.

## Domain registry

Domains register in this explicit order in `server/bootstrap.ts` (route order is
part of the contract; see the per-domain notes):

1. `admin` — `/api/admin`, the owner's separate surface (must be registered
   before `auth` so its prefix is matched before the auth domain's `/api`
   router and its session gate)
2. `health` — `GET /health`, the only unauthenticated non-login route
3. `auth` — `/api` (sessions, users) and the session-gated `/api` router every
   later domain attaches to
4. `batches` — `/api/batches`, `/api/models`
5. `parts` — `/api/skus`, `/api/parts`, `/api/settings`, `/api/price-audit`
6. `purchaseorders` — `/api/purchase-orders`
7. `rma` - `/api/rma-orders`, `/api/rma-parts`, `/api/rma-credits`
7a. `buybacks` - `/api/buyback-orders`, `/api/buyback-parts` (ticket 27)
7b. `returns` - `/api/return-orders` (ticket 29 — return orders: Available parts shipped back, revenue booked at completion)
8. `batchparts` — `/api/batches/…/parts`, `/api/demand`, `/api/parts/:serial/attachments`
9. `audits` — `/api/audits`, `/api/cycle-counts`
10. `search` — `/api/search`
11. `reports` — `/api/reports`

Every domain registers TWICE: the entrypoint (`server/index.ts`) builds one
app context for the production database and a second for the sandbox database
(`data/sandbox.sqlite`), and `registerDomains` runs the same list over both.
The sandbox app mounts at `/sandbox` on the main listener — Express
prefix-strips the prefix, so every route below is identical in both
instances (the sandbox's `/sandbox/health` is the same `GET /health` route).
The instances differ only at the context seams — database handle, cookie
names (`session` vs `sandbox_session`, `admin_session` vs
`sandbox_admin_session`), mount prefix, backup filename stem
(`repair-inventory-…` vs `sandbox-…` snapshots, both in `data/backups/`), and
the staged-swap seam (`pending-restore` vs `pending-restore-sandbox` marker
and staged files, `pre-restore` vs `pre-restore-sandbox` startup pre-swap
backups, and which swap routes register) —
never inside a domain rule. The
sandbox app is mounted BEFORE the production static/SPA fallback is
attached: the fallback excludes only `/api` paths, so mounted later it would
answer `/sandbox/api/...` requests with the SPA shell instead of the sandbox
instance.

"Who can call it" vocabulary below: **any** = any signed-in user (every route on
the shared `/api` router is session-gated), **manager** = `requireManager`,
**public** = no session required, **admin** = the admin panel's own key session
(never the app's user session).

---

## admin

The owner's separate surface — settings, backups, restore, clear, a guarded SQL
console, an .env editor, a restart button, an API console, and system info —
under `/api/admin`, with its own key-based
authentication that never reads the app's `session` cookie.

When `ADMIN_KEY` is unset the entire surface is disabled: every `/api/admin`
route answers 404, revealing nothing.

### Routes (all `/api/admin`, admin key session unless noted)

| Route | Who | Behavior |
| --- | --- | --- |
| `POST /session` | public (rate-limited: 5 failed attempts/min/IP) | Admin key login; sets the instance's admin-session cookie (`admin_session` in prod, `sandbox_admin_session` in the sandbox instance); token lives only in process memory |
| `GET /session` | admin | Session check |
| `DELETE /session` | admin | Log out (clears cookie, drops token) |
| `GET /settings` | admin | All settings with their minimums and defaults |
| `PATCH /settings` | admin | Update one setting; same validation rule as the manager settings route; event recorded actor-less (`via: "admin"`) |
| `GET /backup` | admin | One consistent online backup into `data/backups/` and streamed as a download — named `<instance backup stem>-YYYYMMDD-HHMMSS.sqlite` (`repair-inventory-…` in prod, `sandbox-…` in the sandbox; same folder, so the prefix says which database a file holds) |
| `POST /clear` | admin | Requires typing `ERASE ALL DATA`; backs up first, then drops every table and re-runs the migration runner, then re-provisions the bootstrap manager |
| `POST /restore` | admin | **Production instance only** (the sandbox's reset routes supersede it there; the route answers an explicit 404 in the sandbox). Upload a `.sqlite` file (raw body); validate (integrity check + migration history); back up the current database; stage the file + marker into THIS instance's staging slot; the swap happens at the next server restart |
| `GET /reset/sources` | admin | **Sandbox instance only.** Every `.sqlite` in `data/backups/`, newest first — filename, size, mtime — including `sandbox-` snapshots, which are labeled (`sandboxSnapshot`). An empty folder comes back as `{ sources: [], empty: true }` so the panel can say so loudly; uploads still work |
| `POST /reset` | admin | **Sandbox instance only.** Reset the sandbox from a backup — `{ filename }` picked from the sources list, or an uploaded raw `.sqlite` body (`?filename=`), both validated (integrity check + migration history) BEFORE anything is touched. Then, in the prod Restore order: auto-backup the current sandbox database (filename in the response), stage the file into the SANDBOX's OWN staging slot (`pending-restore-sandbox…` marker next to `data/sandbox.sqlite`; the picked source is copied, never moved), respond `restartRequired`. The swap happens at the next restart: sandbox sessions die (they live in the DB) and trainee-created users vanish. Manual only — no schedule, no auto-reset |
| `GET /sql/write-mode` | admin | Whether this admin session has write mode enabled |
| `POST /sql/write-mode` | admin | Requires typing `ALLOW WRITES`; enables writes for this session |
| `DELETE /sql/write-mode` | admin | Disable write mode for this session |
| `POST /sql` | admin | Run one SQL statement. Read-only default: a single SELECT only. In write mode, any statement; every non-SELECT is backed up first. Everything executed is logged to the console |
| `GET /system` | admin | Row counts per table, applied migrations, uptime, database path/size, backups directory, Node/app versions |
| `GET /users` | admin | The user list (id, email, role, active, created) — the same shape the manager-gated /api/users serves |
| `POST /users` | admin | Create a user: `{ email, role }` (admin / manager / tech); the email allowlist and duplicate refusal live in the ONE `createUser` core (shared with the manager API). The panel is the bootstrap path: a fresh or wiped database has zero users, and this creates the first |
| `PATCH /users/:id/role` | admin | Set the role through the ONE `changeUserRole` core (shared with the manager API): the last active manager/admin cannot be demoted (409); the event records from → to with no actor and `via: "admin panel"` |
| `PATCH /users/:id/active` | admin | Deactivate/reactivate through the ONE `setUserActive` core (shared with the manager API): deactivation kills the user's sessions in the same transaction; the last active manager/admin cannot be deactivated (409) |
| `POST /users/:id/login-link` | admin | Mint a login link for an existing user: same 15-minute single-use token as the public login flow, delivered through the email plug AND returned in the response (the admin key holder may need to hand it over directly — this is how a panel-created user gets in when email is not configured). A deactivated user is refused (reactivate first) |
| `GET /env` | admin | The .env catalog (ticket 22): editable keys (`APP_ORIGIN`, `RESEND_KEY`, `RESEND_FROM`, `ADMIN_KEY`) and read-only `DB_PATH`/`PORT` with reasons. Secrets are masked (`(set ····abcd)` / `(not set)` / `(set ····)`) — the full value never leaves the server. Each entry carries a boolean `pendingRestart` (file value differs from live `process.env`); the flag alone is sent, never both values. The response also carries read-only `instance` facts — the db path and mount prefix THIS panel governs, resolved by the composition root (the sandbox trainer sees exactly which file the sandbox is) |
| `PUT /env` | admin | Save one editable key to the .env file. Read-only and unknown keys are refused with the reason; a secret submitted empty is a no-op. Atomic write (temp file + rename) preserving comments, blank lines, and unknown keys (`admin/envfile.ts`). Logs the KEY changed, never a secret's value. Every response states the change takes effect at the next restart |
| `GET /restart` | admin | The supervision gate state (ticket 22): allowed in `dev` (`npm_lifecycle_event === "dev"`, tsx watch restarts on exit) or when `ALLOW_RESTART=true`; otherwise refused, with the explanation |
| `POST /restart` | admin | Requires typing `RESTART`. Refused 409 outside dev unless `ALLOW_RESTART=true`. Otherwise responds 200 first, then `process.exit(0)` after a short delay. Ends all admin sessions (in memory); main-app sessions live in the database and survive |
| `POST /api-console` | admin | Dispatch `{method, path, body?}` against this same app over `127.0.0.1:<PORT>`, at the context's mount prefix (prod: `/api/...` unchanged; the sandbox panel dispatches `/sandbox/api/...` so the call lands on the SANDBOX app — without the prefix it would hit production with a sandbox cookie). Runs AS the FIRST active manager-or-admin user: creates a real session via the auth session seam and attaches it as the main session cookie (ephemeral — deleted after the dispatch); refused when none exists (the Users section creates one). Guards: same-app paths only (`/api/...` or `/health`, no `..`), method limited to GET/POST/PATCH/PUT/DELETE, body must be a JSON object. Status, key headers, and body are returned verbatim (non-2xx included, not hidden) |

### State machines

None of its own. Danger actions are guarded by procedure, not state: backup
first, typed confirmation, console log with timestamp.

---

## health

Liveness probe and the proof that schema → API works.

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `GET /health` | public | Returns `{ status: "ok", migrations: <count> }` (count of applied migration rows) |

---

## auth

Passwordless login (magic links through the email plug), persistent sessions,
user management — and, as its registration side effect, the shared
session-gated `/api` router every later domain attaches its routes to.

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `POST /api/auth/request-link` | public | Email must belong to a domain configured in `ALLOWED_EMAIL_DOMAINS` (the .env setting) and be an existing active user; creates a single-use 15-minute login token; sends the link via the email plug (the console, today); answers 202 with no link in the body |
| `POST /api/auth/redeem` | public | Consumes the token in a transaction (single-use even under concurrent redemptions) and sets the session cookie; a re-presented token from the same browser's session is answered with success (double-submit tolerance) |
| `GET /api/auth/me` | any | The current user |
| `POST /api/auth/logout` | any | Deletes the session row, clears the cookie |
| `GET /api/users` | manager | List users |
| `POST /api/users` | manager | Create a user (allowlisted email, `manager` or `tech`) |
| `PATCH /api/users/:id/role` | manager | Change role; 409 if it would leave no active manager |
| `POST /api/users/:id/deactivate` | manager | Deactivate; the user's sessions are deleted immediately; 409 if last active manager |

### State machines

- **Login token**: created (unused) → used (redeemed once) or expired (15
  minutes). Single-use is enforced transactionally.
- **Session**: created on redeem → deleted on logout or user deactivation. No
  server-side expiry; the browser cookie caps at 400 days.
- **User**: active ↔ deactivated (manager action; last active manager is
  protected). Role: tech ↔ manager (manager action; same protection).

---

## batches

The batch record — the authoritative record of devices, approval, and repair
status for a group of devices — its device rows, the maintained Model list, and
the per-batch timeline. The lifecycle and Repair Status graph live in
`batches/lifecycle.ts` and `batches/statuses.ts`; the HTTP files are only edges.

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `POST /api/batches` | any | Create a batch (sequential human number) with a required opening note; starts Awaiting approval |
| `GET /api/batches` | any | List summaries, newest number first — the full lifecycle record (`status`, approval and close fields) via the shared `BATCH_SELECT`, plus each batch's `openingNote` (its creation note, read from the batch's first `note.added` event; a missing event or a missing `status` fails loud instead of rendering blank) |
| `GET /api/batches/:id` | any | Detail: devices (each with server-computed `allowedNextStatuses`), derived device counts, approval/close records, timeline |
| `POST /api/batches/:id/approve` | manager | Optional note (the sign-off is the record; a given-but-blank note is refused); Awaiting approval → Open. Requires EVERY live device to carry a per-device decision — undecided devices are named in the 409 (removed devices need none, ticket 30). In one transaction: rejected devices end in the terminal **Denied Repair** (their parts return to stock with a denial auto-note, resolution notes = the rejection's note) and the approved Parts Cost covers APPROVED devices only; the `batch.approved` event records the total and the denied devices |
| `POST /api/batches/:batchId/devices/:deviceId/approval` | manager | The per-device decision (ticket 25): `{ decision: "approved" \| "rejected", note?, priceAddLimitCents? }`; a rejection's OPTIONAL note becomes the denial's resolution notes (without one, the denial's record is the rejection event itself); the optional **Price Add Limit** (ticket 28, whole cents ≥ 0, default 0 = no post-approval headroom) is set with the decision and kept when omitted. Awaiting-approval-only; re-deciding is allowed until the batch opens (the latest wins); every decision is a `device.approval_decided` event |
| `POST /api/batches/:batchId/devices/approve-all` | manager | Bulk "Approve all devices" (the batch page button): approves EVERY undecided device in one transaction, each with the standard `device.approval_decided` event (`via: "approve_all"`). Devices already decided — rejected ones included — are never touched; 409 when there is nothing left to decide or the batch is not Awaiting approval |
| `PATCH /api/batches/:batchId/devices/:deviceId/price-limit` | manager | Change a device's Price Add Limit in place (ticket 28): `{ priceAddLimitCents, note? }`; allowed while the batch is Awaiting approval or Open, refused on Closed; `device.price_limit_changed` records old → new. Lowering below the already-spent amount is allowed — future additions simply refuse |
| `POST /api/batches/:id/close` | any | Open → Closed, only when every device row is terminal (409 names the non-terminal devices); settles installed parts by the device's terminal status (Repaired: Buybackable → Buyback / else Unavailable; Unrepairable → Available; see the close settlement under State machines) |
| `POST /api/batches/:id/notes` | any | Add an immutable note (timeline event) |
| `GET /api/batches/:id/timeline` | any | The batch's events AND its devices' events, merged chronologically |
| `POST /api/batches/:batchId/devices` | any | Add a device row: ≥ 1 of IMEI / Asset ID / serial number; refused on a Closed batch; duplicate IMEI is a warning, never a refusal. Optional **pre-attach** (`preAttach`: entries of `{skuId}` or `{serial}` — exactly one each; `quantity` only on consumable SKU entries): the entries route on kind through the parts domain's cores — a serialized SKU entry reserves its oldest Available unit (or files a Need to Order when stock is short, auto-moving the device to Parts needed); a serial entry reserves THAT exact unit (404 unknown / 409 not Available); a CONSUMABLE entry records usage (quantity, default 1, × unit price — the cost is tracked, the item has no units) — nested in the SAME transaction as the device row. Atomic: any refusal (unknown SKU/serial, quantity on a serialized entry, a tech's Price Add Limit) rolls the WHOLE creation back — the device never enters the batch half-equipped; a manager's pre-attach on an Open batch amends the approval per part (note optional) |
| `PATCH /api/batches/:batchId/devices/:deviceId` | any | Edit fields (partial merge); `repairStatus` is refused here — the status endpoint owns it. `locBin` (ticket 08) rides the same validation (clearable text: absent = unchanged, present-but-empty = cleared) but is CURRENT STATE, not history — it updates the column and is deliberately excluded from the `device.edited` event (a loc/bin-only edit writes no event at all) |
| `POST /api/batches/:batchId/devices/:deviceId/status` | any | The guarded Repair Status change (graph + lifecycle gates + resolution notes + retriage) via `setRepairStatus`; removed devices 404 |
| `POST /api/batches/:batchId/devices/:deviceId/remove` | any | Remove the device from its batch (ticket 30): required note; accepted while the batch is Awaiting approval or Open; a terminal device or Closed batch is refused. One transaction: every active attachment returns to stock (Available, `returnAttachmentsToStock` reason `device_removed`), every OPEN demand of the device becomes cancelled, the row is soft-removed (`removed_at/by/note` — lists, counts, costs, and searches filter it out; the row and its events remain for history), and on an Open batch the standing approval is AMENDED (the total recomputes without the device) |
| `GET /api/batches/:batchId/devices/:deviceId/history` | any | Cross-batch device history: rows sharing an identifier, plus the retriage chain |
| `GET /api/models` | any | The maintained Model list |
| `POST /api/models` | any | Add a Model by name (case-insensitive); 409 if the name exists; models are never edited or removed. Web seam (ticket 07): the `ModelPicker` (`web/src/components/ModelPicker.tsx`) searches this list with the shared SKU ranker (`web/src/skuSearch.ts` — one search implementation, SKU picker and model picker), offers inline create-if-missing on zero results, and on a 409 refetches the list and selects the case-insensitive matching row instead of duplicating it. Choosing a model feeds `SkuPicker`'s `suggestFor`, which ranks SKUs whose names match the model first |

### State machines

**Batch lifecycle** (stored on `batches.status`; written only by
`batches/lifecycle.ts`):

```
Awaiting approval → Open   (manager approve; optional note; every device decided - approved or
                            rejected, each with an optional Price Add Limit; records approved cost)
Open → Closed             (any user; every device terminal; parts settle by the device's terminal
                           status — see the close settlement below)
```

- No transitions out of Closed. A Closed batch accepts no new devices, no
  status changes, and no device removals — its record is finished.
- **Close settlement** (ticket 03): `settleBatchParts` routes every
  still-Reserved part through `movePartFromReserved` by its DEVICE's terminal
  status — Repaired: Buybackable SKU → Buyback, any other SKU → Unavailable
  (the part was used by the repair); Unrepairable: every part → Available
  (the repair is reversed, the applied part is good stock); Additional issues
  present / Denied Repair: no settlement decision (retriage moved their
  attachments to the continuation device; denial returned their parts at
  approval — leftovers keep the loud `alreadyUnavailable` listing). Each
  part's `part.status_changed` event names its close reason
  (`batch_closed_repaired_buyback`, `batch_closed_repaired_unavailable`,
  `batch_closed_unrepairable_available`, `batch_closed`) — system events, no
  user note. Buying into Buyback respects the buybackable guard in
  `parts/status.ts`. The reports domain reads these settlement events: a
  part whose settlement ends it Unavailable is a CONSUMED part, and the
  expense report's non-purchased consumption listing keys off exactly these
  reasons (the expense TOTAL counts PO receipts now, not consumption — see
  the reports domain).

- No transitions out of Closed. A Closed batch accepts no new devices, no
  status changes, and no device removals — its record is finished.
- Approval gates repair, not reservation: on an Awaiting approval batch the
  only device transition accepted is → Parts needed.
- **Device removal** (ticket 30): any tech, Awaiting approval or Open,
  non-terminal devices only — parts → Available, open demand → cancelled,
  the row soft-removed; on an Open batch it amends the standing approval.
- **Price Add Limit** (ticket 28): after the batch is Open, a tech may add
  parts and record consumable usage on a device while the device's DERIVED
  post-approval spend (active attachments + consumable usage created after
  `approved_at`) plus the new addition stays within the limit — equal to it
  is allowed. Over the limit the addition is refused (409) naming the limit,
  the spend so far, the addition's cost, and the three options: a manager
  override in place, retriage via Additional issues present, or Unrepairable.
  Swaps and manager additions are not gated; a retriage starts a fresh cycle
  with a fresh (default 0) limit.

**Device Repair Status graph** (stored on `devices.repair_status`; written only
by `setRepairStatus`, which the status endpoint, batchparts' demand auto-move,
and the fulfillment auto-unblock all call):

```
Awaiting repair → In progress | Parts needed
In progress → Awaiting repair | QA | Parts needed | Repaired | Unrepairable | Additional issues present
QA → In progress | Parts needed | Repaired | Unrepairable | Additional issues present
Parts needed → In progress | Awaiting repair   (the unblock exit is refused while an open Need to
                             Order remains; fulfillment of the LAST open need auto-returns the
                             device to Awaiting repair — see the demand record machine)
Repaired → Awaiting repair | In progress | QA
Unrepairable → In progress | QA
Additional issues present → In progress | QA
Denied Repair → Awaiting repair   (still NO graph edge reaches it)
```

- Reaching a terminal status may carry resolution notes (optional; a given-but-blank value is refused).
- **Terminal is not a trap** (accident correction): every terminal status
  carries exits, because a terminal status can be set BY ACCIDENT and there
  must be a way to fix it — any user, through the same status endpoint,
  evented `from → to` like any transition. The exit does NOT undo the
  terminal status's side effects: leaving `Additional issues present` does
  not undo the retriage (the continuation row keeps the moved parts — remove
  that accidental device through the normal device-removal flow); leaving
  `Denied Repair` does not re-reserve the parts returned to stock at the
  denial (re-add them through the normal part flow).
- **Putting a phone down** (any user): `In progress` and `Repaired` both
  exit to `Awaiting repair` — a tech who picks a device up and puts it back
  down, or records Repaired in error, rewinds the work state to the shelf.
  The device's parts stay attached and Reserved; only the status moves.
- **Denied Repair** (ticket 25) is reachable ONLY through the manager's
  per-device rejection at batch approval — `approveBatch` writes it directly
  inside the approval transaction (the lifecycle module owns the column);
  the bare status endpoint refuses it ("a device cannot move from … to
  Denied Repair"). Its resolution notes are the rejection's note; the
  device's parts were returned to stock at approval.
- `Additional issues present` retriages the device in the same transaction: a
  new batch (Awaiting approval, fresh approval required), a new device row
  continuing the old one (`prior_device_id`), and the old row's reserved parts
  and open demand moved onto it.
- The allowed transitions for a device are serialized onto every device
  (`allowedNextStatuses`) narrowed by the batch lifecycle — the client never
  re-encodes the rules.

---

## parts

The SKU catalog, intake of serialized parts (migration and salvage — the
non-PO intake door), the part-status module's HTTP edge, the per-part price
module (`parts/effective-price.ts` — the ONE resolver of the effective Part
Price and the owner of every later price write), the stock module
(`parts/stock.ts` — the ONE definition of a SKU's on-hand count and of the
below-minimum list the purchaseorders domain reads), price expiry with the
manager's price-audit queue, and the app settings.

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `GET /api/skus` | any | List SKUs with price staleness and Available counts |
| `POST /api/skus` | any | Create a SKU (name, price, kind serialized/consumable, optional free-text `defaultSourceUrl` — ticket 11's default source link, `""` stored as NULL, optional `minOnHand` — CONTEXT.md: Minimum On-hand, serialized-only, default 0) |
| `GET /api/skus/:id` | any | SKU detail with its parts and timeline |
| `PATCH /api/skus/:id` | any | Rename and/or reprice (each change recorded as an event); kind correction `consumable → serialized` always allowed, `serialized → consumable` refused while serialized parts exist OR a minimum on-hand > 0 stands — note required on any kind change; the default source link (ticket 11) is a plain field — `""` clears it, no note required, a change is recorded as `sku.source_changed`; the minimum on-hand (CONTEXT.md: Minimum On-hand) is likewise a plain field — serialized-only (refused on consumables), no note required, a change is recorded as `sku.min_on_hand_changed` |
| `DELETE /api/skus/:id` | any | Delete a mis-entered SKU; note required; refused with counts while serialized parts, consumable usage, demand records, or PO lines reference it; a `sku.deleted` event naming the SKU survives the row |
| `POST /api/skus/:id/parts` | any | Non-PO intake: `{ source: "migration", quantity 1–200, counted (required bool) }` or `{ source: "salvage", note (required provenance) }`; optional `price` = the parts' own price override (Part Price, ticket 23). Each part then auto-reserves FIFO onto the OLDEST outstanding Need to Order demand for the SKU through batchparts' shared auto-reserve seam (snapshot = the part's own effective price; the approval is amended in place; exempt from the Price Add Limit), and the demand is fulfilled with the same guarded open-check as a receipt — fulfillment auto-returns a Parts-needed device to Awaiting repair when it was the device's last open need; a device-less demand is fulfilled from stock with no attachment; a seam refusal (lifecycle gate) leaves the part Available and is surfaced in the response; the response records per part which demand/batch/device took it (`reserved`, `demandId`, `batchId`, `batchNumber`, `deviceId`, `deviceLabel`, `reservationRefusal`) |
| `POST /api/skus/:id/price-refresh` | manager | Refresh the price (optionally changing it), resetting price staleness |
| `GET /api/parts/labels` | any | Label data for a comma-separated `ids` list; 404 naming any missing id. Registered BEFORE `GET /:serial`, which would otherwise match "labels" as a serial |
| `GET /api/parts/:serial` | any | Part detail with SKU and timeline; the price shown is the part's EFFECTIVE price (its own override ?? the SKU price), with `overrideCents`/`priceOverridden` exposing which |
| `POST /api/parts/:serial/status` | any | The bare "a human changes a status" door: required note; refuses making a part Reserved, refuses setting In-Transit (only an order's scan does that), and refuses moving a Reserved part or one attached to an open RMA/buyback/return order |
| `POST /api/parts/:serial/price` | any* | The Part Price re-price door: required price + note; records `part.price_changed` (old → new). Locking (`parts/effective-price.ts setPartPrice`): any user while the part is unattached or its active attachment's batch is Awaiting approval; manager-only on an Open batch (the note amends the approval); refused on a Closed batch. Refusals name the batch. The active attachment's snapshot follows the new effective price |
| `GET /api/price-audit` | manager | The stale-price queue (SKUs past `price_expiry_days`), oldest first |
| `GET /api/settings` | any | All settings as `{ key: number or string }` — numbers for int settings, the trimmed text value for text settings |
| `PATCH /api/settings` | manager | Update one setting (int: whole number at least the definition's minimum; string: trimmed text capped at its max length) |

### State machines

Serialized Part statuses are owned by `parts/status.ts` (see Shared
infrastructure). The bare endpoint's door into it:

```
available → unavailable | rma | damaged_by_tech | buyback     (note required)
unavailable | rma | buyback → (anything except reserved)      (note required)
damaged_by_tech → (anything except reserved)                  (note required)
reserved → refused here — the part belongs to its Batch
→ reserved — refused everywhere except batchparts' reservation
→ buyback — refused unless the SKU is buybackable (ticket 27)
→ in_transit — refused everywhere except an order's scan (via: "order_scan",
   ticket 29): Available/RMA/Buyback → in_transit joins an open shipment
in_transit → refused here; the part belongs to its order — that order's
   Complete settles it to Unavailable
a part on an in-transit RMA, buyback, or return order — refused here; the
  order's Complete settles it
```

Price staleness is not a status, it is derived: a SKU is stale when
`price_updated_at` + `price_expiry_days` ≤ now. Staleness warns; it never
blocks use.

---

## purchaseorders

The paperwork half (create, manager approval, tracking) and the physical half
(expected serials, label sheets, scan-to-receive, auto-reservation,
close-with-shortfall).

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `POST /api/purchase-orders` | any | Create: purpose, required opening note, ≥ 1 line (SKU, quantity, unit price), optional sources/shipping/tracking, optional `demandId` per line; marks referenced demand ordered in the link table |
| `GET /api/purchase-orders` | any | List summaries |
| `GET /api/purchase-orders/demand` | any | The outstanding Need to Order queue (open demand records this domain has not marked ordered) PLUS `lowStock`: the serialized SKUs whose on-hand stock (parts/stock.ts's one Available-count definition) sits below their `min_on_hand`, each with the shortfall as the suggested line quantity — a read-time prompt with no lifecycle; receiving stock is what removes a row |
| `GET /api/purchase-orders/suggestions` | any | Distinct past purposes and sources, freshest first |
| `GET /api/purchase-orders/:id` | any | Detail: lines, tracking, expected serials, demand links, total, timeline. Each line carries its demand label data (ticket 04): the demand id, the demanding batch's number, and the demanding device's identifier (Asset ID, else IMEI, else serial — a read-time join on `devices`, never a stored copy); a missing demand row fails loud instead of rendering blank |
| `GET /api/purchase-orders/:id/timeline` | any | The order's timeline |
| `POST /api/purchase-orders/:id/notes` | any | Add an immutable note |
| `POST /api/purchase-orders/:id/tracking` | any | Append a carrier + tracking number (append-only) |
| `POST /api/purchase-orders/:id/lines` | any | Replace the line set — Awaiting approval only (409 after): the SAME line schema as creation (SKU, quantity, unit price, optional source, optional demand refs) plus an optional note. One transaction rewrites the lines and re-derives the demand links (see the state-machine notes) and records ONE `po.lines_changed` event: the new line set, previous → new line count and lines total, the demand-link diff (`demandMarked` / `demandReleased`), and the note when given. A loud guard refuses the rewrite if any line somehow carries received quantities |
| `DELETE /api/purchase-orders/:id` | any | HARD-delete the draft — Awaiting approval only (409 after, 404 unknown): demand links, lines, tracking entries, the PO's timeline events, and the row, one transaction, children first. No note — nothing survives to carry one; the status gate is the record. The sequential number is reusable (MAX+1). Released demands return to the outstanding queue automatically |
| `POST /api/purchase-orders/:id/approve` | manager | Awaiting approval → In-transit; the note is OPTIONAL (the sign-off is the record; a given-but-blank note is refused, never silently dropped) and lands in the `po.status_changed` payload only when given; pre-assigns expected serials so labels can print |
| `POST /api/purchase-orders/:id/shipping-cost` | manager | Set the shipping cost (non-negative amount, stored as integer cents matching the column CHECK) with an optional note; any status except Closed; records `po.shipping_changed` (old → new, plus the note when given); the total recomputes from the column, which expense reporting also reads |
| `GET /api/purchase-orders/:id/labels` | any | Label sheet for the expected serials; 409 while Awaiting approval; idempotently ensures the serials exist (with an event) |
| `POST /api/purchase-orders/:id/receive` | any | Scan a serial: creates the part as Available (the scan is the intake) with its price stamped to the line's unit cost (Part Price, ticket 23), bumps the line, refreshes the SKU price to the line's unit cost, fulfills a Need to Order demand and auto-reserves the part onto the demanding device through batchparts' shared auto-reserve seam (snapshot = unit cost; the approval is amended in place to that price with the receipt as the recorded cause; exempt from the Price Add Limit; a Closed batch refuses the reservation — the receipt still completes and the demand stays open), and fulfillment auto-returns a Parts-needed device to Awaiting repair when it was the device's last open need, then recomputes the status |
| `POST /api/purchase-orders/:id/receive-consumable` | any | Receive a quantity against a consumable line (no serials) |
| `POST /api/purchase-orders/:id/close` | any | Close with a shortfall (required note); refused when every line is fully received. RELEASES the demand records the PO marked ordered: the `purchase_order_demand` links are deleted, so every still-open demand returns to the outstanding queue with no `demand_records` write (a shortfall means the goods never came — the need is unmet and orderable again); the released ids ride the close event (`demandReleased`) |

### State machines

**Purchase Order lifecycle** (stored on `purchase_orders.status`):

```
Awaiting approval → In-transit            (manager approve; optional note; serials pre-assigned)
In-transit → Partially received → Received (DERIVED from line received quantities — never hand-set)
In-transit | Partially received → Closed   (close with shortfall; required note)
```

- Only In-transit and Partially received can receive or close.
- Received is terminal; Closed is terminal.
- **Awaiting approval is a draft** (spec: `.scratch/po-pre-approval-edits/`):
  nothing physical references the PO yet — expected serials are assigned at
  approval and nothing can be received — so any user may replace its lines
  (`POST /:id/lines`, optional note, one `po.lines_changed` event) or delete
  it whole (`DELETE /:id`, hard delete, children and timeline included).
  Approval is what freezes the paperwork; after it only the shipping cost
  may still move (its own manager route).
- **Demand links on revision** are RE-DERIVED, not round-tripped: the link
  table is PO-grain (only each line's first ref is stored on the line), so
  per-line demand sets cannot survive a rewrite. A previously-linked demand
  STAYS linked while its record is open AND its SKU still has a line in the
  new set; explicit refs on the submitted lines mark NEW demands ordered
  (same validation as creation: open record on an Open batch); everything
  else is released back to the outstanding queue. A cancelled or fulfilled
  demand is pruned either way.
- **Shortfall close releases demand**: ordering only HID a demand from the
  outstanding queue (the link subtraction is the whole mechanism), so a PO
  closing without its goods would hide an unmet need forever.
  `closeWithShortfall` deletes the PO's `purchase_order_demand` links —
  every still-open record returns to both queues automatically, no
  `demand_records` write; the close event names the released ids
  (`demandReleased`).

**Need to Order demand record** (stored on `demand_records.status`, owned by
batchparts):

```
open → fulfilled   (an arriving part — a PO receipt or a salvage/migration intake — is matched to the demand and the part auto-reserved; a Closed batch refuses the reservation and the record stays open for manual resolution. Fulfillment of a device's LAST open record auto-returns that device from Parts needed to Awaiting repair through setRepairStatus — a device not in Parts needed, or one with other open records, is left as it is)
open → cancelled   (device removal from the batch — the need died with the device's run, ticket 30)
```

Ordering (a PO referencing the demand) does NOT fulfill it — it only stops the
demand being outstanding in the shared outstanding-demand queue, served by both
`GET /api/demand` and `GET /api/purchase-orders/demand`. Only OPEN demand may be
marked ordered (ticket 30): `demandExists` checks `status = 'open'`, and receipt
(`pickDemand`) serves only open records — a cancelled demand can never
auto-reserve a received unit onto its removed device. A shortfall close deletes
the PO's links, which un-hides the demand: the ordering hide is temporary by
design, ending at fulfillment, cancellation, or the close.

---

## rma

Shipments of RMA-status parts back to a vendor: scan parts onto an order
(ticket 29: the scan moves each part to In-Transit), then Complete it with a
per-part disposition and a credit value entered by hand when the vendor
accepts. While open, the order shows an estimated recovery — 50% of its
parts' price sum — computed server-side, display-only.

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `POST /api/rma-orders` | any | Create with a required opening note; starts In-Transit (no approval gate) |
| `GET /api/rma-orders` | any | List summaries |
| `GET /api/rma-orders/:id` | any | Detail: parts with dispositions, totals, timeline |
| `POST /api/rma-orders/:id/notes` | any | Add an immutable note |
| `GET /api/rma-orders/:id/timeline` | any | The order's timeline |
| `POST /api/rma-orders/:id/parts` | any | Scan a serial: only RMA-status parts attach, and only to one open order; the scan moves the part to In-Transit (ticket 29). Summaries carry `partsValueCents` and `estimatedValueCents` (50% — the open order's estimated recovery) |
| `POST /api/rma-orders/:id/complete` | any | Required completion note plus, for EVERY part on the order, a disposition (`credited` with a required credit value entered by hand when the vendor accepts, or `rejected` with none); every part becomes Unavailable; order → Complete |
| `GET /api/rma-parts` | any | The pool: unscanned RMA-status parts plus the parts In-Transit on an open RMA order, each with the open order it is attached to, if any |
| `GET /api/rma-credits` | manager | Recovery query: completed orders in a date interval with credit totals |

### State machines

**RMA Order lifecycle** (stored on `rma_orders.status`):

```
in_transit → complete   (any user; required note; every part settled Unavailable)
```

Complete is terminal; nothing is ever added to a completed order.

---

## buybacks

The supplier sell-back flow (ticket 27) — the RMA structure earning money:
CONTEXT.md's **Buyback** status, **Buybackable** SKU flag, and **Buyback
Order**. The part-status vocabulary and the in-transit-order guard live in
`parts/status.ts` (the same module that owns RMA's); the order lifecycle,
pool, and pool override live here. Settlement is ORDER-level: Complete takes
ONE hand-entered value for the whole shipment — no per-part dispositions
(buyback-order-value spec).

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `POST /api/buyback-orders` | any | Create with a required opening note; starts In-Transit (no approval gate) |
| `GET /api/buyback-orders` | any | List summaries |
| `GET /api/buyback-orders/:id` | any | Detail: the parts that shipped (attachment record only — no per-part dispositions), totals, timeline |
| `POST /api/buyback-orders/:id/notes` | any | Add an immutable note |
| `GET /api/buyback-orders/:id/timeline` | any | The order's timeline |
| `POST /api/buyback-orders/:id/parts` | any | Scan a serial: only Buyback-status parts attach, and only to one open order; the scan moves the part to In-Transit (ticket 29). Summaries carry `partsValueCents` and `estimatedValueCents` (10% — the open order's estimated recovery) |
| `POST /api/buyback-orders/:id/complete` | any | Required completion note plus ONE hand-entered order value — the whole shipment's recovery revenue; no per-part dispositions; every part becomes Unavailable; order → Complete |
| `GET /api/buyback-parts` | any | The pool: unscanned Buyback-status parts plus the parts In-Transit on an open buyback order, each with the open order it is attached to, if any |
| `POST /api/buyback-parts/:id/override` | any | Move a pooled part OUT before it is scanned onto an order: `{ destination: available/rma/damaged_by_tech/unavailable, note (required) }` through the part-status module — a part already on an in-transit order refuses here too |

### State machines

**Buyback Order lifecycle** (stored on `buyback_orders.status`):

```
in_transit → complete   (any user; required note; ONE hand-entered order
                          value; every part settled Unavailable)
```

Complete is terminal; nothing is ever added to a completed order. The order
value is the revenue record — `buyback_order_parts` carries no dispositions
or prices (the attachment record only).

**Entering the pool.** Removing a part with the **Buyback** destination puts
it in the pool — the destination is always the remover's explicit choice
(ticket 02: no default, not even for Buybackable SKUs).
The bare part-status endpoint also accepts → buyback, but only for
buybackable SKUs. The pool override (or any bare status change) moves a part
out before shipment; once scanned onto an In-Transit order, only that order's
Complete settles the part.

---

## returns

Return orders (ticket 29) — shipments of **Available** parts back to a
vendor (CONTEXT.md: Return Order). Like the RMA flow but the value needs no
hand entry: on Complete each part's EFFECTIVE price (override ?? SKU,
ticket 23) is snapshotted onto the order line and counts as booked revenue in
reports. Lives under the RMA tab in the UI; its own number space.

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `POST /api/return-orders` | any | Create with a required opening note; starts In-Transit (no approval gate) |
| `GET /api/return-orders` | any | List summaries — `revenueCents` (booked, complete orders) and `estimatedValueCents` (the parts' price sum, shown at 100% while open) |
| `GET /api/return-orders/:id` | any | Detail: parts with their effective prices, timeline |
| `POST /api/return-orders/:id/notes` | any | Add an immutable note |
| `GET /api/return-orders/:id/timeline` | any | The order's timeline |
| `POST /api/return-orders/:id/parts` | any | Scan a serial: only Available parts attach (the difference from RMA/buyback), and only to one open order; the scan moves the part to In-Transit |
| `POST /api/return-orders/:id/complete` | any | Required completion note only — no per-part dispositions; every part becomes Unavailable and its current effective price is snapshotted onto the order line as booked revenue; order → Complete |

### State machines

**Return Order lifecycle** (stored on `return_orders.status`):

```
in_transit → complete   (any user; required note; every part settled
                          Unavailable at its snapshotted price)
```

**Revenue booking.** The price snapshot happens at Complete (not at scan):
money the shop books is money the shipment actually carried, and a later
reprice cannot rewrite a completed order (tested).

---

## batchparts

The parts half of a Batch: reservations (always through a batch), Need to Order
demand, same-SKU swaps, removals, consumable usage, and the computed Parts
Cost. Reservation is guarded: the pick, the guarded status flip, and the
attachment row are one atomic write. The write rules live in TWO callable
cores in `batchparts/attach.ts`, each with one caller set so there is exactly
one writer per rule however a part reaches a device: `attachSkuToDevice`
(reserve a serialized unit by SKU or scanned serial — used by the add-part
endpoint and by device creation's pre-attach) and `recordConsumableUsage`
(record consumable usage — used by the consumables endpoint and by device
creation's pre-attach).

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `POST /api/batches/:batchId/devices/:deviceId/parts` | any | Add a part by SKU or by SCANNED SERIAL — exactly one of `skuId` / `serial`: by SKU, the oldest Available unit is reserved; by scan, THAT exact unit is reserved and the unit's own SKU row drives the add (unknown serial 404s; a unit that is not Available 409s — a scan is a physical fact, so the scan path NEVER falls back to a Need to Order). Snapshot = the unit's EFFECTIVE price (the optional `price` field stamps the unit's override, "sourced from eBay at $X"; refused loudly if no unit was Available to price); when SKU stock is short the endpoint creates a Need to Order demand and auto-moves the device to Parts needed. Terminal devices refuse; on an Open batch a TECH's addition is gated by the device's Price Add Limit (409 naming limit/spend/cost and the options — manager override, retriage, Unrepairable; equal-to-limit allowed; managers bypass; the demand path adds no cost and is not gated); a manager's change amends the approval (note optional) |
| `POST /api/batches/:batchId/devices/:deviceId/consumables` | any | Record consumable usage (quantity × unit price) through `recordConsumableUsage`, the one consumable core (also device creation's pre-attach); same approval gates and the same Price Add Limit gate (usage counts against the device's post-approval spend the moment it is recorded) |
| `POST /api/batches/:batchId/devices/:deviceId/consumables/:usageId/remove` | any | Remove consumable usage (a cost correction) through `removeConsumableUsage`, the one consumable core: required note; the row is SOFT-removed (migration 0021 — kept with removed_at/by/note, so Parts Cost drops via the active-only sum while the record stays auditable) and a `device.consumable_removed` event records usage, cost, and note. Same gate as part removal (tickets 30 + 02): any device on a live batch qualifies — post-approval and terminal included; refused only on a Closed batch. The removal amends the standing approval with the note (the `always` shape — it only ever reduces cost, whatever the role) |
| `POST /api/batches/:batchId/devices/:deviceId/parts/:attachmentId/swap` | any | Same-SKU swap: reserve a replacement — the optional scanned `serial` names THAT exact unit (404 unknown, 409 wrong-SKU or not Available); blank picks the oldest Available unit (snapshotted at the replacement's own EFFECTIVE price) — and send the old part to a destination (available / rma / damaged_by_tech) with a required note |
| `POST /api/batches/:batchId/devices/:deviceId/parts/:attachmentId/remove` | any | Remove: the part takes an EXPLICIT destination + required note — never a silent return to stock, and never a guessed destination (ticket 02 deletes ticket 27's Buybackable default: `destination` is required for every SKU). The removal gate (tickets 30 + 02): a tech may remove from ANY device on a live batch — post-approval and terminal-but-not-absorbing included (Repaired / Unrepairable / Additional issues present); only a Closed batch refuses (409). A removal only ever reduces cost, so it is never manager-gated, and it AMENDS the standing approval in place with the required note (the `always` shape), whatever the role. The UI always offers Remove and starts its dialog unselected |
| `GET /api/batches/:batchId/parts` | any | Per LIVE device (removed devices are gone from the listing): attachments (price-overridden parts marked), consumable usage, demand, the COMPUTED Parts Cost, and — ticket 06, display only — the open demands' SKU-price estimate as its OWN fields (`openDemandEstimateCents` + `openDemandEstimate` label, "NTO — est. $X"; null when nothing is open). The estimate never enters `partsCostCents` or `approved_cost_cents` — a demand is an estimate, not a signed-off cost; ticket 09's arrival amendment makes it real |
| `GET /api/batches/:batchId/demand` | any | The batch's Need to Order records |
| `GET /api/demand` | any | The global outstanding demand queue (same shared definition as `GET /api/purchase-orders/demand` — the PO form prompts from the PO endpoint) |
| `GET /api/parts/:serial/attachments` | any | A part's full attachment history across all batches, past included |

### State machines

**Attachment** (`device_parts` row): active (`removed_at` NULL) → removed, with
the full removal record (when / who / where `removed_to` / why `removal_note` /
kind `removal_reason`). The schema CHECK makes a half-filled removal
impossible; the partial unique index allows at most one active attachment per
part.

**Demand record** (`demand_records.status`): `open → fulfilled | cancelled`
(fulfilment is written by the purchaseorders receipt path and the parts
intake path; cancellation by the batches domain's `removeDeviceFromBatch`
through batchparts' guarded `cancelDemand` — see the matrix). Fulfillment
carries one status consequence: the demanding device's LAST open record
fulfilled auto-returns it from Parts needed to Awaiting repair
(`batches/lifecycle.ts autoUnblockAfterDemandFulfilled`, called by both
arrival doors).

---

## audits

The counting discipline: audit windows that run themselves (opened
automatically on the `audit_interval_months` cadence — the only manual open
is the manager's one-time bootstrap of the very first window, ticket 02 /
ADR-0002), scanning serials, cycle counts, and the no-grace close that turns
due-but-unscanned parts into the shrink signal. The window lifecycle — the
one writer of `audits` rows and `audit_parts.outcome`, shared by the routes
and the lazy boundary processor — lives in `audits/lifecycle.ts`.

**The lazy mechanism (no background jobs, ADR-0002):** every authenticated
audits-domain request runs `processDueBoundaries` first (router middleware,
plus the cycle-counts route). It checks whether an
`audit_interval_months` boundary has passed since the last audit's cadence
anchor and, if so, settles the open window (if any) and opens the next one
from the LATEST missed boundary in one transaction. The banner's 60-second
`GET /api/audits/status` poll is the natural trigger, so shop time is
covered without infrastructure; timestamps are accurate to the first request
after the boundary, never the boundary instant.

**The banner (web `AuditBanner` + `web/src/auditBanner.ts`, ticket 04):** the
UI renders only the two steady states of the lifecycle — the open window
naming the live audit and its boundary (`lastScheduledAt` IS the open
window's own boundary, because an open window is always the newest audit),
or the gap countdown to the next scheduled open. The old
due/one-week/two-weeks nag ladder is gone — the open window IS the nag — and
the bootstrap state (no audits yet) renders nothing; the Counting page is
where a manager opens the first window. The Counting page mirrors the same
states: the Open control exists only in the bootstrap state and only for
manager powers, and the Close button is visible to everyone but enabled only
for manager powers (the client-side mirror of ticket 03's `requireManager`
gate — the server stays the enforcer).

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `GET /api/audits/status` | any | The audit calendar: interval, last audit, the last audit's `scheduled_at` (`lastScheduledAt`), the next boundary, open audit id. The lazy boundary processor has already run, so the payload always reflects the post-transition state. The payload also still carries the pre-lifecycle `banner.stage` ladder field, but since ticket 04 nothing reads it: the banner derives its two steady states from `openAuditId` / `lastScheduledAt` / `nextAuditAt` alone |
| `POST /api/audits` | manager, **bootstrap only** | Open a window — refused (403) for anyone without manager powers, and refused (409) once ANY audit exists: from the second window on, opening is automatic at the boundary, and a manual open would re-anchor the cadence on an arbitrary date. Succeeds only for a manager on a system with no audits; that bootstrap audit has `scheduled_at` NULL and anchors the cadence on its own `opened_at`. The due list is computed at open time and snapshotted into `audit_parts` |
| `GET /api/audits` | any | List with summaries (each carries `closeKind`) |
| `GET /api/audits/:id` | any | Detail: due / counted / scanned / failed / moved / exempt buckets, `closeKind`, and the timeline |
| `POST /api/audits/:id/scan` | any | Scan a serial into the open window: refreshes the part's last-count date; when the scan disagrees with the recorded status (unavailable / rma / buyback / in_transit), the scan wins and a note is required |
| `POST /api/audits/:id/close` | manager | Settle with no grace: counted (scanned in-window), failed (due, still in circulation → Unavailable; a Reserved part's attachment is settled too), moved (accounted for mid-window). The close kind is COMPUTED from the buckets — any failed part → `shortfall`, none → `complete` — never declared, so a "clean" close with parts left over is unrecordable; no note required. The closing manager is stamped `closed_by` (via `requireManager`, the single manager-powers predicate an admin passes too). Scanning and status stay any-authenticated-user; the boundary auto-close is not a route and needs no gate |
| `POST /api/cycle-counts` | any | Ad-hoc count of one serial under its own SKU, any time: same scan path, same scan-wins rule |

### State machines

**Audit window** (stored on `audits.closed_at`; written only by
`audits/lifecycle.ts`):

```
(no audits yet) → open   (BOOTSTRAP: manager-only manual open, once ever)
open → closed            (a manager closes early — closed_by stamped; OR the
                          next boundary auto-closes — closed_by NULL, actor-less
                          "auto-closed at interval" event naming the boundary and
                          the missed-boundary count)
closed → open            (AUTOMATIC at the next boundary — the lazy processor
                          opens the successor from the latest missed boundary;
                          scheduled_at = that boundary, anchor_at = end of the
                          previous audit's actual open DAY; never by hand)
```

- Exactly one window may be open at a time (the boundary transition's
  close-and-open is one transaction); a closed audit never reopens.
- The per-part outcome (`audit_parts.outcome`) is NULL while open and
  stamped at close: `counted`, `failed`, or `moved`. The close kind is
  computed from the buckets at close (`close_kind`): `failed` present →
  `shortfall`, else `complete` — for manager closes and auto-closes alike.
- **The collapse rule**: if several boundaries pass in silence, the open
  window is settled exactly once (at the first request after the silence)
  and the next window opens from the LATEST missed boundary. Skipped
  windows never exist — replaying each boundary would settle the same
  shrink twice and create phantom zero-lifespan windows — and the timeline
  records the gap (`missedBoundaryCount` on the auto-close event).
- An early close deliberately leaves a quiet gap: the next window opens on
  schedule (at the boundary), not the moment the previous one closes.
- The no-grace settlement is identical whichever way the window closes
  (manager close or boundary auto-close): the same close core, the same
  `changePartStatus` `via: "audit_close"` flips and the same
  Reserved-attachment settlement seam. On an auto-close the part-level
  settlement events name the user whose request triggered the transition
  (there is no system user to attribute a guarded status flip to), while
  the audit's own record keeps `closed_by` NULL and its event actor-less.

**Scheduling** (derived, not stored): the next audit is the last audit's
`scheduled_at` — the boundary that triggered it — plus `audit_interval_months`
(ADR-0002); the bootstrap audit (`scheduled_at` NULL) anchors the cadence on
its own `opened_at`, so the schedule always derives from a real, existing
audit and never drifts with the actual open moment. There is no schedule
until the first audit exists, and after the bootstrap no manual open can
ever move the anchor again.

---

## search

One read-only box over SKUs, serials, device identifiers, and batch/PO/RMA/buyback/return
numbers.

### Routes

| Route | Who | Behavior |
| --- | --- | --- |
| `GET /api/search` | any | `q` plus optional `userId` filter. SKU: case-insensitive substring on name. Serial / device identifiers: exact match. Device loc/bin (ticket 08): case-insensitive SUBSTRING (free text, not an identifier), wildcard-escaped like the SKU search. Batch / PO / RMA / buyback / return: exact number (`#29` and `29` both mean #29). Scan-first: an exact serial hit is returned as `directHit` |

Read-only: no state machines, no writes.

---

## reports

The manager CSV downloads over date ranges (the five of ticket 12 plus the
returns-revenue report of ticket 29).

### Routes (all manager-only, all require `from`/`to` as YYYY-MM-DD, both inclusive, validated loudly)

| Route | Behavior |
| --- | --- |
| `GET /api/reports/expenses` | Receipt-based spend: every PO receipt in the interval — serialized units at their line's unit cost (`purchase_order_expected_serials`, interval on `received_at`), consumable receipts at quantity × line unit cost (`po.consumable_received` events) — plus PO shipping at creation. Consumable usage is NOT an expense (it would double-count the receipts; it remains the Parts Cost record). Non-purchased consumption (consumed migration/salvage parts, from the close-settlement events) listed separately, excluded from the total |
| `GET /api/reports/rma-recovery` | Credited and rejected parts of completed RMA orders, interval on `completed_at` |
| `GET /api/reports/batches-completed` | Batches closed in the interval with device counts by final Repair Status (Repaired / Unrepairable / Additional issues / Denied) |
| `GET /api/reports/buyback-recovery` | The ONE hand-entered value of each completed buyback order (the recovery revenue) and the interval total — order granularity, no per-part lines |
| `GET /api/reports/returns-revenue` | Completed return orders in the interval: every settled part at its snapshotted revenue price (booked, no manual entry — ticket 29) and the interval total |
| `GET /api/reports/shrink` | Damaged by Tech events and audit failures, each priced at the SKU price |
| `GET /api/reports/tech-stats` | Per tech: repairs completed (status-changed-to-Repaired events), average repair time, damage attributed |

All are read-only CSV downloads (RFC-4180 quoting, CRLF, attachment).

---

## Cross-domain reads/writes matrix

Table ownership (the domain whose folder owns the table):

| Domain | Tables it owns |
| --- | --- |
| auth | `users`, `login_tokens`, `sessions`, `events` |
| parts | `skus`, `serialized_parts`, `app_settings`, `serial_id_claims` |
| batches | `batches`, `devices`, `device_models` |
| batchparts | `device_parts`, `device_consumables`, `demand_records` |
| purchaseorders | `purchase_orders`, `purchase_order_lines`, `purchase_order_tracking`, `purchase_order_demand`, `purchase_order_expected_serials` |
| rma | `rma_orders`, `rma_order_parts` |
| audits | `audits`, `audit_parts` |
| admin | none — it operates on the database file and delegates; see below |
| health | reads `migrations` (the migration runner's table) |
| search, reports | none — read-only over everyone else's tables |

The matrix: what each domain does to OTHER domains' tables, and through what
contract. R = read, W = write.

| Domain | Touches | Tables | Contract |
| --- | --- | --- | --- |
| **batches** | parts | `serialized_parts.status` | W — via `parts/status.ts` guarded primitives (`movePartFromReserved` in the close settlement) |
| batches | batchparts | `device_parts`, `device_consumables`, `demand_records` | R + W — via module import `batchparts/queries.js` (`devicePartsCostCents`, `listActiveAttachmentsForDevice`, `moveAttachmentsToDevice`, `moveOpenDemandToDevice`, `settleBatchParts`, `returnAttachmentsToStock` — the approval denial's return to stock, ticket 25); no raw SQL against those tables |
| batches | auth | `users` | R — direct SQL JOINs for emails; `resolveTech` checks active users |
| batches | auth | `events` | W — via `recordEvent` (the one timeline write path) |
| **batchparts** | parts | `serialized_parts` | R (direct SQL: part lookups, oldest-Available pick — the pick reads the unit's price override) + W (status only, via `reservePart` / `movePartFromReserved`) + W of `price_cents` only via module import `parts/effective-price.js` (`stampPartPriceOverride` — the priced add-part stamps the reserved unit) |
| batchparts | parts | `skus` | R — direct SQL (`getSkuRow`) |
| batchparts | purchaseorders | `purchase_order_demand`, `purchase_orders` | R — direct SQL: the outstanding-demand subquery subtracts ordered ids (the one outstanding-demand definition shared with the PO form), and ticket 29's `serializeDemand` names the carrying PO (`orderedOn`) by reading the link + `purchase_orders.number/status`, so a batch never says "Need to Order" for a part already in transit |
| batchparts | batches | `devices`, `batches` | R (direct SQL: `getBatchDevice`, `getBatchNumber`) + W via module import `batches/lifecycle.js` (`setRepairStatus`, `amendApproval`) — batchparts never UPDATEs those tables directly |
| batchparts | auth | `events` | W — via `recordEvent` |
| **parts** | rma | `rma_orders`, `rma_order_parts` | R — direct SQL in `parts/status.ts` (`openInTransitOrder`: the one definition of "attached to an open outbound order", covering RMA/buyback/return — ticket 29) |
| parts | buybacks | `buyback_orders`, `buyback_order_parts` | R — direct SQL in `parts/status.ts` (`openInTransitOrder`, same query) + R of `skus.buybackable` (the bare endpoint refuses → buyback on a non-buybackable SKU) |
| parts | returns | `return_orders`, `return_order_parts` | R — direct SQL in `parts/status.ts` (`openInTransitOrder`, same query — ticket 29) |
| parts | batches | `devices`, `batches` (read), `batches.approved_cost_cents` (W) | R + W via module import `batches/lifecycle.js` (`amendApproval`) inside `parts/effective-price.ts setPartPrice` — the Open-batch re-price amends the approval in the same transaction; batchparts→batches has the same shape |
| parts | batchparts | `demand_records` (R queue + W status), `device_parts` (W) | R + W — intake auto-reserve (ticket 10): `parts/intake.ts` picks the OLDEST demand from `batchparts/queries.js listOutstandingDemand` (the ONE outstanding-demand definition, unedited) and flips it open → fulfilled with the same guarded `WHERE status = 'open'` UPDATE the receipt uses (fulfillment's device unblock goes through `batches/lifecycle.js autoUnblockAfterDemandFulfilled` — the same move a receipt makes); the attachment goes through `batchparts/autoreserve.js autoReserveOntoDemandDevice` (the ONE auto-reserve seam — lifecycle check, guarded reserve, amendment) at the part's own effective price (`parts/effective-price.js resolveEffectivePriceCents`) |
| parts | audits | `serialized_parts.last_counted_at` | W via module import `audits/counting.js` (`applyCount`) — migration intake with a confirmed count goes through the one counting seam |
| parts | auth | `events` | W — via `recordEvent` |
| **purchaseorders** | parts | `serialized_parts` | W — direct INSERT on scan-to-receive (receipt is one of the two intake doors; `intake_source` stamped `'purchase-order'`, `price_cents` stamped with the received unit cost — ticket 23) |
| purchaseorders | parts | `skus` | R (line validation) + W (price refresh to the received unit cost on every receipt) — direct SQL |
| purchaseorders | parts | `serial_id_claims` | W — via module import `parts/serials.js` (`claimSerialIds`, `releaseSerialClaim`) |
| purchaseorders | batchparts | `demand_records` | R — direct SQL (`demandExists`, `pickDemand`) + W — the receipt's guarded `UPDATE … SET status = 'fulfilled'` (the receipt contract anticipated by migration 0005); a shortfall close releases the PO's links by deleting `purchase_order_demand` rows (the demand rows themselves are never rewritten — the link subtraction returns them to the outstanding queue) |
| purchaseorders | batches | `devices.repair_status` | W — via module import `batches/lifecycle.js` (`autoUnblockAfterDemandFulfilled`): the fulfillment flip's status consequence auto-returns a Parts-needed device to Awaiting repair when the fulfilled demand was its last open need — no direct SQL |
| purchaseorders | batchparts | `device_parts` | W — via module import `batchparts/autoreserve.js` (`autoReserveOntoDemandDevice`: the ONE auto-reserve seam — lifecycle check, guarded `reservePart` flip, `insertAttachment`, and the approval amended in place via `batches/lifecycle.js amendApproval`; also writes the reservation events) |
| purchaseorders | auth | `events` | W — via `recordEvent` |
| **rma** | parts | `serialized_parts` | R (direct SQL: lookups, pool query) + W (status only, via `changePartStatus` `via: "order_scan"` on scan and `"rma_complete"` on completion — ticket 29) |
| rma | auth | `events` | W — via `recordEvent` |
| **buybacks** | parts | `serialized_parts` | R (lookups, pool query) + W (status only, via `changePartStatus` `via: "order_scan"` / `"buyback_complete"`) |
| buybacks | auth | `events` | W — via `recordEvent` |
| **returns** | parts | `serialized_parts` | R (lookups; the effective-price read that becomes the revenue snapshot) + W (status only, via `changePartStatus` `via: "order_scan"` / `"return_complete"`) — ticket 29 |
| returns | auth | `events` | W — via `recordEvent` |
| **audits** | parts | `serialized_parts` | R (counting core) + W — `last_counted_at` updated directly by `audits/counting.ts` `applyCount` (the one place last-count dates refresh); status flips via `changePartStatus` (`via: "audit_close"` / `"scan_wins"`) |
| audits | rma / buybacks / returns | — | No read any more (ticket 29): the in-transit exemption reads the part's own `in_transit` status — the order tables are no longer consulted for due-ness |
| audits | batchparts | `device_parts` | W — via module import `batchparts/queries.js` (`settleAttachmentForAuditFailure`) |
| audits | parts | `app_settings` | R — via module import `parts/settings.js` (`getSettingInt('audit_interval_months')`) |
| audits | auth | `events` | W — via `recordEvent` |
| **search** | parts, batches, purchaseorders, rma, buybacks, returns, auth | `skus`, `serialized_parts`, `devices`, `batches`, `purchase_orders`, `rma_orders`, `buyback_orders`, `return_orders`, `users` | R only — direct SQL |
| **reports** | auth, batches, batchparts, parts, purchaseorders, rma, buybacks, returns, audits | `events` (via `timelineEvents`), `batches`, `devices`, `device_parts`, `serialized_parts`, `skus`, `purchase_orders`, `purchase_order_lines`, `purchase_order_expected_serials`, `rma_orders`, `rma_order_parts`, `buyback_orders`, `buyback_order_parts`, `return_orders`, `return_order_parts`, `audits`, `audit_parts`, `users` | R only — the timeline through `auth/timeline.js`, the rest direct SQL |
| **admin** | auth | `users` | W + R — via module import `auth/users.js` (`createUser` / `changeUserRole` / `setUserActive`, actor null: the panel creates users, changes roles, and deactivates/reactivates — the wipe-and-recreate path has no bootstrap manager anymore) |
| admin | parts | `app_settings` | R + W — via module import `parts/settings.js` (definitions + `validateSettingValue`; the one validation rule shared with the manager route) |
| admin | auth | `events` | W — via `recordEvent` (settings events, actor-less) |
| admin | everything | the database file itself | W — `admin/backups.ts`: consistent online backup, staged restore, wipe-and-recreate through the migration runner |
| admin | the .env file | `<project root>/.env` | R + W — `admin/envfile.ts` (ticket 22): parse/render preserving comments and unknown keys, atomic temp+rename write; `RMS_ENV_FILE` overrides the path as the documented test seam. Also reads live `process.env` for pending-restart flags |
| admin | auth | `sessions` | W — via module import `auth/session.js` `createSession`/`deleteSession`: the API console creates one ephemeral session for the first active manager/admin per dispatch and deletes it after |
| admin | auth | `users` | R — the API console resolves the first active manager/admin before dispatching; the login-link mint reads the user and `login_tokens` W (the same single-use token shape as the public login flow) |
| **auth** | — | — | Nothing outside its own tables |
| **health** | db runner | `migrations` | R — row count |

Reading the matrix: `parts/status.ts` is the single writer of part-status
flips (seven domains import it — batchparts, purchaseorders, rma, buybacks,
returns, audits, search); `batchparts/queries.js` is the single seam for
attachment/demand/consumable writes by other domains (three importers);
`recordEvent` is the single timeline writer (every domain); `setRepairStatus`
is the single writer of `devices.repair_status` (two callers). A new maintainer
changing one of those modules changes behavior in every domain listed against
it — that is the point of the map.

---

## Shared infrastructure

**Instance context** (`server/domain.ts`, wired in `server/index.ts`). Every
domain receives one `AppContext`: the database handle, the clock, the
database file path, the session and admin cookie names, the mount prefix, the
backup filename stem, the email plug (see below — both instances select it
the same way), and the staged-swap seam (`stagedRestore`: marker stem,
pre-swap backup stem, and which swap routes the instance registers).
There are no globals for these — the prod values (`session`, `admin_session`,
`""`, `repair-inventory`, `pending-restore`/`pre-restore`, restore route) and
the sandbox values (`sandbox_session`, `sandbox_admin_session`, `/sandbox`,
`sandbox`, `pending-restore-sandbox`/`pre-restore-sandbox`, reset routes) are
named constants, and the
production entrypoint and the test
harness both build their instances from them explicitly. The audit calendar
has no timer anywhere (windows open lazily inside requests), so each
instance's schedule runs off its own database with no shared scheduler state.
On the client side the same seam appears once: ONE built bundle serves both
environments — `web/src/sandbox.ts` derives `isSandbox` from the URL path,
prefixes every API call with the instance's mount prefix, and the router
mounts under `/sandbox` when present (plus the persistent SANDBOX banner) —
so no second build exists and no domain rule ever branches on the
environment.

**Clock** (`server/clock.ts`). One interface, `now(): Date`. Production code
never reads wall time; tests inject a fake clock through the harness and
exercise time-dependent rules (login-link expiry, price expiry, audit
due-ness) without sleeping.

**Migrations runner** (`server/db/migrate.ts`). Applies numbered SQL files
(`0001-<slug>.sql`, …) from `server/db/migrations/` in order, recording each in
the `migrations` table; refuses gaps, renumbering, or a recorded migration
missing from the directory; `applied_at` is stamped through the clock. Migrations
are additive and portable SQL only (ADR-0001). The database opens in WAL mode
with foreign keys enforced (`server/db/connection.ts`).

**Events/timeline seam** (`server/domains/auth/events.ts` write,
`server/domains/auth/timeline.ts` read). One append-only `events` table and one
write function, `recordEvent(db, clock, { entityType, entityId, actorId,
action, payload })`; actions are `<entity>.<past-tense-verb>`, typed notes are
events (`note.added`), and `actorId` is null when the system acts. The read
side gives every domain one query shape and one JSON event shape, plus the
`registerNotesRoute` factory — the one POST `/:id/notes` implementation shared
by batches, POs, RMA orders, buyback orders, and return orders. Notes are
immutable everywhere: no edit or delete route exists.

**Parts status module** (`server/domains/parts/status.ts`). The one owner of
the Serialized Part status vocabulary, the guarded transitions, and the
`part.status_changed` event. Its primitives — `reservePart` (only from
Available), `movePartFromReserved` (only from Reserved), and
`changePartStatus` (rule-checked, guarded on the expected current status,
transaction-composable, throws on inconsistency) — are the only writers of
`serialized_parts.status`; seven domains import it and no domain writes that
column with raw SQL. The In-Transit guard (`openInTransitOrder`, ticket 29)
is read-only across the rma/buybacks/returns order tables — the one
definition of "attached to an open outbound order."

**Serial allocator** (`server/domains/parts/serials.ts`). System-assigned
serials are `P` + zero-padded id. `nextPartId` considers both existing parts
and outstanding `serial_id_claims`, so ad-hoc intake and PO label
pre-assignment can never hand out the same barcode; a claim lives until the
part row exists (receipt consumes it, intake occupies the id directly).

**Email plug** (`server/domains/auth/email-plug.ts`). The one seam login links
flow through: `sendLoginLink(to, url, expiresAt)`. The plug is part of the app
context — the composition root picks it once per instance, never as a runtime
fallback, and BOTH instances run the SAME selection (`createEmailPlugFromEnv`):
**Resend** when `RESEND_KEY` is set (real email
through resend.com's HTTP API from the configured sender (`RESEND_FROM`,
defaulting to `onboarding@resend.com`, which delivers only to the account
owner's address until a domain is verified) and it fails loudly on rejection)
and the **logging plug** otherwise — the sandbox included, since 2026-10-06
(reversal of spec decision 7 by user request: training exercises the real
email path, so handing links over the console is not smart). The logging plug
writes each link to the server console
(and an in-memory outbox tests read). Login links are built by ONE shared
helper (`buildLoginLinkUrl` in `auth/index.ts`), used by both the public
request-link flow and the admin panel's mint route: the request's Origin wins,
`APP_ORIGIN` is the fallback, and the context's mount prefix is part of the
path — sandbox links are `${origin}/sandbox/redeem?...`, prod's stay
unprefixed. The link is never returned in an API response.

**Admin gate** (`server/domains/admin/auth.ts`). The admin surface's own
authentication: a shared `ADMIN_KEY` from the environment, held in a dedicated
admin-session cookie (the name comes from the instance context:
`admin_session` in prod, `sandbox_admin_session` in the sandbox), tokens only
in process memory (a restart requires
re-entering the key), constant-time key comparison, and a per-IP failed-attempt
limiter. It never reads the app's `session` cookie — a main-app session grants
nothing here. With `ADMIN_KEY` unset, every `/api/admin` route answers 404.

**Session-gated `/api` router** (`server/domains/auth/index.ts`). The auth
domain mounts `/api` with a session middleware and then `requireSession`;
every later domain registers its routes on that router and receives
`req.currentUser` for free. `getApiRouter(app)` is the accessor — it throws if
auth was not registered first, which the bootstrap order guarantees.

**App settings** (`server/domains/parts/settings.ts`). Manager-editable
key/value rows in `app_settings` with typed definitions (type, minimum,
default): `price_expiry_days` (90), `audit_interval_months` (2),
`label_width_sixteenths` (37), `label_height_sixteenths` (64), and the text
setting `dymo_printer_name` (default empty, max 200 characters — the DYMO
printer choice for ticket 19's direct label printing; the row is created on
first write, no migration). A stored value that fails its definition throws
loudly instead of degrading to a silent default.

**Money** (`server/domains/parts/prices.ts`). Integer cents in storage; dollars
exist only at the edges — `parsePriceToCents` on the way in (refuses more than
two decimal places), `formatCents` on the way out. Every money column in the
schema is `*_cents` with a `>= 0` CHECK.
