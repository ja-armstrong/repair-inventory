# 11 — SKU default source link

Status: ready-for-human

## Problem

Ordering a demand means re-finding the vendor page by hand. Sources today are free text with history-based suggestions only (`purchase_order_lines.source`, `demand_records.supplier` — there is no supplier entity, by design at this shop size). The SKU has nowhere to remember "buy this at <url>".

## Decision (user-confirmed)

One free-text **link per SKU** (e.g. `source.com/part`):

- Migration: `skus.default_source_url TEXT NULL` (next migration number in implementation order — 0023/0024 depending on whether ticket 08 landed first; never reuse a number).
- SKU create/edit gains the field.
- **New PO lines pre-fill** `source` from the SKU's default link; **NTO demand** pre-fills `supplier` the same way.
- Any PO-line source (or demand supplier) that **parses as a URL renders clickable** on the PO page — including history-suggested values; free text remains fully valid and renders as plain text.
- Still editable per line — the default is a convenience, never a lock.

## Implementation notes

- URL detection should be strict (scheme + rest), not "contains a dot" — a non-URL must never render as a broken link.
- Do not introduce a supplier entity; this stays a string field (grilling decision).

## Acceptance

- SKU with default link: creating a PO line for it pre-fills the link; opening an NTO for it pre-fills supplier; both render clickable; both remain editable/free-text.
- SKU without one: current behavior unchanged.
- Non-URL sources never render as links.

## Doc obligations

- `docs/data-model.md`: `skus.default_source_url`.
- `CONTEXT.md` **SKU**/`Purchase Order` lines (default source link), `docs/manual.md` (ordering flow).

## Comments

- Origin: grilling session 2026-10-05 (spec decision 10). User: "a link, like source.com/part, such that it's easy to click and add to cart from the PO page while ordering demand."
- 2026-10-05, implemented (agent):
  - `server/db/migrations/0023-skus-default-source-url.sql` — plain `ALTER TABLE skus ADD COLUMN default_source_url TEXT` (nullable, 0020-style); existing rows carry NULL. Took 0023; 0024 belongs to ticket 08, untouched.
  - `server/domains/parts/index.ts` (the skus domain) — `createSkuSchema`/`patchSkuSchema` gain optional free-text `defaultSourceUrl` (trim, ≤2000 chars, no URL validation at write time — the stored value is whatever the tech pasted); POST inserts it (in `sku.created` payload when present); PATCH updates it as a plain field — no note required (the default is a convenience, never a lock) — but a change is recorded as a new `sku.source_changed` event `{ from, to }`; `""` (after trim) normalizes to NULL on both paths so "none" has one representation, and an unchanged save emits no event. `serializeSku` returns it as `defaultSourceUrl`; all three `SkuRow` SELECTs (detail, list, price-audit) carry the column so the serializer never reads undefined.
  - Demand threading — `server/domains/batchparts/queries.ts` `DEMAND_SELECT`/`DemandJoinRow` gains `s.default_source_url AS sku_default_source_url` (the shared outstanding-demand definition stays the ONE source both demand endpoints read); `server/domains/purchaseorders/demand.ts` maps it through `DemandSummary` and `OutstandingDemandGroup` as `defaultSourceUrl`. No server prefill of demand supplier — that is a form convenience (below); the demand write path is unchanged.
  - `web/src/sourceLink.ts` (new, ONE shared helper) — `urlHref(raw)`: strict URL detection, null = stays plain text. Explicit scheme accepted ONLY for http/https (javascript:/mailto:/file: never link; parsed with `new URL` to reject garbage); scheme-less values only when unambiguously URL-shaped — dotted alphanumeric host with at least one letter (so `3.5`, `12.34`, `192.168.0.1` are not links), no whitespace anywhere (prose never mangles into a link), optional path/query; the ticket's `source.com/part` qualifies and gets `https://` supplied at render time. Plus `prefillLineSource({ skuDefaultSourceUrl, demandSupplier })`: SKU default first, demand supplier fallback, blank last. `web/src/components/SourceText.tsx` (new) renders a stored value as an anchor (`target="_blank" rel="noreferrer"`, stored text verbatim) or plain text off that one decision.
  - `web/src/pages/PurchaseOrderCreatePage.tsx` — demand-linked lines prefill source via `prefillLineSource` (SKU default preferred over the record's supplier); manually picking a line SKU prefills source the same way the price does (`sku?.defaultSourceUrl ?? line.source`, demand-linked lines keep their resolved prefill); the demand table's supplier cell renders through `SourceText`. `web/src/pages/PurchaseOrderDetailPage.tsx` — the Source column renders through `SourceText`, so history-suggested values are clickable too and non-URLs stay text.
  - `web/src/components/DeviceParts.tsx` — picking a SKU in the add-part form prefills the supplier field from that SKU's `defaultSourceUrl` (cleared when the new SKU has none — a previous SKU's link never leaks). `web/src/components/SkuPicker.tsx` — `SkuPickerOption` gains optional `defaultSourceUrl` (additive; the option shape is the one SKU option shape). `web/src/pages/InventoryPage.tsx` — the create form gains an optional "Default source link" input; `web/src/pages/SkuDetailPage.tsx` — the edit form gains the field (always sent; the server no-ops when unchanged) and the facts list shows it through `SourceText`.
  - No supplier entity introduced; per-line editability untouched.
  - Tests: `web/src/sourceLink.test.ts` (10) — strictness matrix: http/https accepted, scheme-less `source.com/part` (+path/query) accepted with https supplied, javascript:/mailto:/file:/data: rejected, prose/notes/"contains a dot" numbers rejected, blank null; prefill order (SKU default > supplier > blank). `server/tests/parts.test.ts` (+5, `SkuBody` interface extended) — create-with-link round-trips list/detail, absent/empty → NULL, PATCH updates + `sku.source_changed` payload, empty-string clear, no-op save emits no event, non-URL free text accepted. `server/tests/purchase-orders.test.ts` (+1) — demand groups thread `defaultSourceUrl` (with and without a SKU default; supplier fallback intact).
  - Docs: `docs/data-model.md` (skus altered 0023: column row + prefill/read-time-detector invariant), `CONTEXT.md` (SKU default source link, PO line-source prefill/clickability, Need to Order supplier prefill), `docs/logic-map.md` (POST/PATCH /api/skus rows), `docs/manual.md` (section 7: prefill + clickable-source wording).
  - Verified: `node node_modules/vitest/vitest.mjs run` — full suite 529/529 green (504 baseline + 16 here + ticket 08's concurrent 9); typecheck clean on both `tsconfig.json` and `web`. Ticket-08 files untouched; tickets 04/05 changes in `PurchaseOrderDetailPage.tsx` built on, not reverted. Nothing committed.
