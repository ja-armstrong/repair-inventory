# 24: Create a SKU from the search box

**What to build:** When the SKU picker's fuzzy search finds nothing, the picker offers the missing SKU's creation inline: "No results found" and beneath it, "Add 'iPhone 14 Screen - MobileSentrix LCD' as a SKU" — the typed query becomes the new SKU's name (editable before creating).

- **Inline creation form** inside the picker (expanded from the create row): name (pre-filled with the query, editable), kind (serialized/consumable), price — the same fields the SKU create form has, small. POST /api/skus (existing endpoint, no server change).
- **Continuity**: after creation the picker auto-selects the new SKU and the consuming flow proceeds exactly as if it had been picked — batch add-part opens with it selected; intake continues with it; a PO line is added with it. The consumer decides what "selected" triggers; the picker just delivers the SKU.
- The create row appears **only when the results list is empty** (a non-empty list means a SKU matched — use it, or refine the query).
- Keep the picker's contract: same props/callbacks plus an optional `allowCreate` + `onCreated(sku)`; every existing call site keeps working unchanged; enable creation at all SKU-selection sites (batch add-part, intake, PO lines, cycle count? — cycle counting a SKU that doesn't exist makes no sense; enable where the ticket's flows say: add-part, intake, PO lines).
- The new SKU's creation is event-recorded server-side as today; the picker surface adds nothing to the timeline.

**Blocked by:** none (independent of 23 and 25).

**Status:** ready-for-human

- [x] Zero-results state shows "No results found" + the create row carrying the exact query text
- [x] Inline form creates the SKU (name editable, kind, price) and auto-selects it, continuing the consuming flow
- [x] Enabled at batch add-part, intake, and PO lines; cycle count picker unchanged
- [x] Full suite, typecheck, build green; manual.md's picking sections updated in the same commit

## Comments

**Implementation — `SkuPicker.tsx` only, no server change (as specified).**
New optional props `allowCreate` and `onCreated(sku)`; every existing call
site compiles unchanged (both default off). The offer renders exactly when
`allowCreate && query.trim() !== "" && results.length === 0` — which includes
the empty-catalog case (intake with zero SKUs), since an empty catalog has an
empty result list too. Collapsed: "No results found." + **Add "…" as a SKU**
(the exact query). Expanded: name (pre-filled with the query, editable), kind
(select, defaults to the picker's `kind` filter), price — POST /api/skus;
on success the picker calls `onCreated`, auto-selects the new SKU, and closes,
so the consuming flow proceeds exactly as if it had been picked. The catalog
still empty → `emptyMessage` with no offer; a non-empty result list never
offers creation.

**HTML constraint worth recording.** The picker lives inside the consuming
page's `<form>`, and nested `<form>` elements are stripped by the HTML
parser — so the inline form is a styled `<div>` with explicit buttons and an
explicit Enter handler (preventDefault + stopPropagation so it never submits
the outer form). Related: while the form is open, the search input's blur no
longer closes the list (focus moves into the form's inputs); clicking the
offer row keeps the list open via the established onMouseDown-preventDefault
pattern.

**Call-site wiring.** IntakePage and PurchaseOrderCreatePage append the
created SKU to their own catalog state via `onCreated`. The batch parts panel
threads a new `onSkuCreated` prop: BatchDetailPage → DeviceGrid →
DevicePartsPanel → the add-part picker only (the consumable-usage picker is
unchanged — creating a consumable from a parts panel has no flow that uses
it). PurchaseOrderCreatePage additionally keeps the created row in a ref map:
the picker selects the new SKU in the same event that creates it, and the
memoized `skuById` map lags one render, so the line's unit-price prefill
would otherwise miss.

**No automated component tests** — the repo has no DOM test environment (no
jsdom/testing-library; the only web test is the pure skuSearch module), and
the ticket demands none. Verification: typecheck, build, and full suite
(361/361) green; manual.md sections 4, 7, and 10 updated in this commit.
