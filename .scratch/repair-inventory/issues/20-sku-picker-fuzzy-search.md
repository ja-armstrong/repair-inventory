# 20: SKU picker — fuzzy search with availability, never truncated

**What to build:** Every SKU dropdown/select (batch add-part, intake, PO lines — grep for all of them) becomes a reusable **SKU picker combobox**: type to fuzzy-search SKU names, pick from a ranked list. Each result shows the **full SKU name** (wrapping, never ellipsized — "(Grade B)" at the end is exactly why), the **Available quantity** directly beneath the name (serialized SKUs), a "consumable" badge (consumables have no stock count), and the price. Zero-Available SKUs stay visible and selectable (that's the Need to Order path) — dimmed, count shown as 0.

- **Fuzzy matching** as a pure, deterministic module with its own vitest test file (a pure function, not the UI — `npm test` covers it): case-insensitive full-name substring ranks first; then all-words-match, word-prefix, and subsequence fallbacks for abbreviations/typos (e.g. "ip13 scr" finds "iPhone 13 Screen"). The ranking is documented in the module; ties break alphabetically.
- **No truncation anywhere** in the picker: result rows wrap; the currently-selected SKU also displays in full.
- **Keyboard**: arrows move, Enter selects, Escape closes; it is a text input, so a stray scanner scan just filters.
- **Availability data**: the SKU list endpoint already returns `availableCount` — verify it covers every SKU (and that consumables carry `null`, which the UI renders as the badge). No server change expected.
- Apply the picker at every SKU-selection site; leave no legacy dropdown behind.

**Blocked by:** none.

**Status:** ready-for-human

- [x] Pure fuzzy-match module with ranking tests (substring > all-words > word-prefix > subsequence; deterministic; tie-break alphabetical)
- [x] Reusable picker component: full-name results (wrapping, never truncated), Available count under the name, consumable badge, price, zero-Available visible and selectable
- [x] Keyboard navigation (arrows/Enter/Escape)
- [x] Every SKU dropdown in the app replaced (batch parts, intake, PO lines, and any others found)
- [x] Full suite (including the new matcher tests), typecheck, build green

## Comments

- `web/src/skuSearch.ts` is the pure matcher; `web/src/skuSearch.test.ts` (18 tests) runs under the
  existing `npm test` — `vitest.config.ts` now includes `web/src/**/*.test.ts`. The web tsconfig
  typechecks the test file; the UI stays build-gated as before.
- Ranking as built (a name is classified at the FIRST tier its whole query satisfies, so tier order
  is result order): 1) substring — whole query contiguous in the name (whitespace-collapsed,
  case-insensitive); 2) all-words — every query token equals a whole name word (words split on
  non-alphanumerics, so "(Grade B)" yields "grade"/"b"; order-independent); 3) word-prefix — every
  token prefixes some name word; 4) subsequence — query characters with spaces ignored appear in
  order ("ip13 scr" → "iPhone 13 Screen"). Within a tier: alphabetical by name, then id. Empty
  query = no filter, given order preserved.
- Tier subtlety: a word-prefix of a name word is always also a substring of the name, so single
  partial tokens ("scr") land on substring; word-prefix is reachable only by multi-token queries
  mixing partial words ("scre 13"). Tested that way.
- `web/src/components/SkuPicker.tsx` is the reusable combobox: text input + ranked list. Rows show
  the full wrapping name (no ellipsis anywhere in the CSS), Available count beneath the name
  (serialized), "consumable" badge, price, "price stale" marker when `priceStale`. Zero-Available
  rows are dimmed (`.sku-picker-option-empty`) but selectable — the Need to Order path. Keyboard:
  ArrowUp/Down move, Enter picks (Enter while open NEVER submits the surrounding form — a PO line
  form would otherwise post itself), Escape closes. `onMouseDown` is suppressed on rows so a click
  doesn't blur-close the list first. The chosen SKU shows in full beneath the closed input.
- All SKU selects replaced: DeviceParts.tsx add-part (serialized) and consumable usage,
  IntakePage.tsx, CycleCountPage.tsx, PurchaseOrderCreatePage.tsx PO lines (all kinds). Grep for
  the old option texts finds nothing left; the only remaining selects are non-SKU (statuses,
  destinations, roles, printers, filters).
- Availability data verified, no server change needed: `GET /api/skus` (`serializeSku` in
  `server/domains/parts/index.ts`) returns `availableCount` for every SKU — a live
  `status='available'` count for serialized SKUs, `null` for consumables — plus `price` and
  `priceStale`. Existing server tests already pin consumable `availableCount === null`.
- `DeviceParts.SkuOption` is now a type alias of `SkuPickerOption` (one shape, one source of truth);
  IntakePage/CycleCount/PO-create now pass the whole catalog and let the picker filter by kind.
- Standing docs: `docs/manual.md` sections 4 (add-part, consumables), 8 (PO lines), 9 (cycle
  counts), and 10 (migration/salvage intake) updated to describe the SKU search box in the same
  commit. Logic map and data model are server-side; unaffected.
- Full suite 315/315 (297 previous + 18 matcher), `npm run typecheck` and `npm run build` green.
