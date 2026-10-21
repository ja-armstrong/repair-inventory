# 11: Search

**What to build:** One search box over everything. Searching matches: SKUs (by name), serialized parts (by serial), devices (by IMEI, Asset ID, or serial number — across all batches, with links to each batch row), batches (by number, bare or with #), POs and RMA orders (by number). Results group by entity type and deep-link to the entity's page. An optional user filter narrows batch/PO/RMA results to those created by (or devices assigned to) that user. Scan-first: typing/scanning a serial into the box lands on the part.

**Blocked by:** 04 (batches and devices), 07 (purchase orders create and approve). Requires the entity types to exist; search itself touches every domain read-only.

**Status:** ready-for-human

- [x] One search endpoint matches SKU names, part serials, device identifiers (IMEI/Asset ID/serial), and batch/PO/RMA numbers; results grouped by type with identifiers for deep links
- [x] Device identifier matches link every batch row the device appeared on (cross-batch history)
- [x] A user filter narrows batches/POs/RMA orders by creator and devices by Assigned Tech
- [x] Searching a bare number ("29") finds batch #29 (and PO/RMA numbers where distinct)
- [x] Search UI: one box in the navigation, results page grouped by type, deep links to entities
- [x] API tests cover each match type, the user filter, and empty/no-match behavior

## Comments

- Endpoint: `GET /api/search?q=<text>&userId=<id>` (session required) in
  `server/domains/search/index.ts`, registered in `server/bootstrap.ts`.
  Response: `{ query, userId, directHit, filterUsers, results: { skus, parts,
  devices, batches, purchaseOrders, rmaOrders } }` — every group is always
  present (possibly empty), so the client renders groups unconditionally.
- Match semantics: SKU names are case-insensitive substrings (LIKE with
  `%`/`_`/`\` escaped — a literal "10%" query matches nothing rather than
  everything); part serials, device identifiers (IMEI/Asset ID/serial
  number), and batch/PO/RMA numbers are EXACT, case-insensitive matches.
  Numbers accept an optional leading `#` ("29" ≡ "#29"); the three number
  spaces are independent, so "2" can hit batch #2 and RMA #2 while no PO #2
  exists. Devices return one hit per batch row, newest batch first — the
  cross-batch history link.
- User filter: narrows batches/POs/RMA orders by `created_by` and devices by
  `assigned_tech_id`; never applies to SKUs or parts (no creator on those
  rows). Malformed `userId` → 400; unknown user id → 404 — never silently
  ignored. `filterUsers` (id + email for every user) rides on the response
  because `/api/users` is manager-only and the results page needs the
  dropdown for any user.
- Scan-first is a server rule: an exact serial match sets
  `directHit: { type: "part", id, serial, skuId }` and the SearchPage
  redirects (replace) to `/inventory/parts/<serial>`.
- Web: search box added to `AppLayout` header (submits to `/search?q=…`);
  `SearchPage` renders grouped tables with deep links
  (`/inventory/skus/:id`, `/inventory/parts/:serial`, `/batches/:batchId`
  for device rows, `/batches/:id`, `/orders/:id`, `/rma/:id`) and a user
  filter that updates the `userId` query param.
- No migrations: search reads existing tables only. Verified against ticket
  08's landed (uncommitted-at-the-time) 0009-po-receiving.sql — additive
  only; every column searched still exists.
- Tests: `server/tests/search.test.ts`, 12 tests at the standard seam
  (session, validation, each match type, wildcard escaping, cross-batch
  device history, bare/# number semantics, filterUsers, user filter
  narrowing, empty/no-match shape). Full suite 199/199 at commit time.
- Note for reviewers: `web/src/styles.css` was committed whole — it carries
  ticket 08's in-flight label-printing CSS (shared-file rule: other
  domains' lines survive). `web/src/main.tsx` was NOT touched by this
  ticket (its `/search` route pre-existed from the scaffold).
