# 03: Parts catalog and serialized inventory

**What to build:** The inventory core. SKUs (name, price, serialized vs consumable) are created and edited; serialized parts are added to stock ad hoc with system-assigned short unique serials; parts carry lifecycle statuses (Available, Reserved, Unavailable, RMA, Damaged by Tech) with required notes on every change; part detail shows the full timeline including cycle-count dates. Prices expire after the configurable interval (default 90 days): stale prices show warnings and land in a manager-visible price-audit queue where a manager records a refreshed price. Consumables exist as SKUs whose usage is cost-only (no stock counts anywhere in this ticket).

**Blocked by:** 02 (auth, users, and roles).

**Status:** ready-for-human

- [x] SKU CRUD: name, price (decimal-safe), serialized/consumable kind; price changes are recorded as timeline events
- [x] Ad-hoc intake adds serialized parts with system-assigned serials; scanning/typing a serial shows the part with status and full history
- [x] Status transitions require a note and record actor + timestamp; invalid transitions (e.g. Reserved → Available from a bare part screen, when reserved to a batch) are rejected
- [x] Price expiry: a SKU's price becomes stale after the configured interval (injectable clock); stale prices warn without blocking use, and appear in a manager queue whose refresh action is event-recorded
- [x] Configurable price-expiry interval stored as an app setting (default 90 days), editable by managers
- [x] Inventory UI: SKU list with price/expiry state, part detail with timeline, price-audit queue for managers
- [x] API tests cover serial uniqueness, transition validation with required notes, expiry computation, and manager-only price refresh

## Comments

Implemented in `server/domains/parts/` (routes in `index.ts`, money edge-formatting in
`prices.ts`, app settings in `settings.ts`), migration `server/db/migrations/0003-parts.sql`,
tests in `server/tests/parts.test.ts` (28 tests at the HTTP seam), and web pages
`InventoryPage`, `SkuDetailPage`, `PartDetailPage`, `PriceAuditPage` plus the shared
`Timeline` component under `/inventory` routes.

**Endpoints** (all session-gated via the auth domain's `/api` router):

- `GET /api/skus`, `POST /api/skus` — list/create (any user; techs create SKUs per spec story 9)
- `GET /api/skus/:id` — detail incl. its serialized parts and the SKU timeline
- `PATCH /api/skus/:id` — rename and/or re-price; both recorded as events
- `POST /api/skus/:id/parts` — ad-hoc intake, optional `quantity` (1–200) and `note`
- `POST /api/skus/:id/price-refresh` — manager-only; re-dates the price, optional new price
- `GET /api/parts/:serial` — part detail: status, SKU (with stale-price state), full timeline
- `POST /api/parts/:serial/status` — `{ status, note }`, note required
- `GET /api/price-audit` — manager-only queue of stale-priced SKUs (with `daysStale`)
- `GET /api/settings`, `PATCH /api/settings` — read for any user, edit manager-only, `{ key, value }`

**Serial format:** `P` + zero-padded part id (P00001, P00002, …) — globally sequential across
all SKUs, unique by construction (derived from the row id inside the intake transaction).
Lookups are case-insensitive.

**Settings keys** (table `app_settings`, seeded by migration 0003): `price_expiry_days`
(default 90), `audit_interval_months` (default 2, seeded now for ticket 10).

**Event actions recorded:** `sku.created`, `sku.renamed`, `sku.price_changed`,
`sku.price_refreshed`, `part.added`, `part.status_changed`, `setting.updated` (plus a
defensive `setting.created` if a settings row is somehow missing). Cycle-count exposure is
generic: `lastCountedAt` on every part + full event history; ticket 10's counts will appear
without changes here.

**Reserved handling:** a bare change *to* Reserved is rejected (400 — reservations only
happen through a Batch) and any change *away from* Reserved is rejected (409 — the Batch owns
the part's status). Reservation ownership itself arrives with ticket 05, which can add its
batch reference to the `serialized_parts` table and lift the 409.

**Deviations / decisions:**

- Prices are integer cents in the DB; the API accepts `"109.99"` or `109.99` and rejects more
  than two decimal places rather than rounding. Responses carry both `price` (formatted
  string) and `priceCents`.
- Stale = `now >= priceUpdatedAt + price_expiry_days` (so exactly 90 days is stale). A price
  *change* via `PATCH` also re-dates the price, consistent with "PO receipt refreshes price"
  in ticket 07.
- Same-status changes are allowed (the required note still records a reason) — useful for
  ticket 10's scan-to-restore flow.
- Manager-only nav item "Price audit" added to `AppLayout` (the only shared web file touched
  besides the router); the page also hosts the settings editor.
