# 07 — Device-model fuzzy search (SKU-search pattern)

Status: ready-for-human

## Problem

Entering a device's model on a batch row has no search affordance; the tech must know the exact model name. SKU selection already has a pure client-side fuzzy ranker (`web/src/skuSearch.ts` — substring → all-words → word-prefix → subsequence, ties by codepoint then id) used by `SkuPicker.tsx`; device models are a maintained list techs may extend (`server/domains/batches/models.ts`, name-unique case-insensitive on create).

## Decision (user-confirmed)

Mirror the SKU search for device models:

- A **ModelPicker** reusing `skuSearch.ts` over the models catalog (same four tiers, same tie-breaks — one search implementation, two consumers, not a copy).
- **Inline create-if-missing**: typing a name that matches nothing offers "add <name>"; creation flows through the existing models endpoint (which already dedupes case-insensitively).
- Selecting a model **immediately filters SKU suggestions** for the device (CONTEXT.md: models "drive compatible part-SKU suggestions").

## Acceptance

- Fuzzy behavior identical to SKU search for the same input classes.
- Creating a new model inline works and selects it; a case-insensitive duplicate is matched, not duplicated (server 409 path surfaces loudly).
- After model selection, the SKU picker's suggestion set reflects the model.

## Doc obligations

- `docs/logic-map.md`: batches/models notes if it documents the picker seam.
- `docs/manual.md`: how model entry works on a device row.

## Comments

- Origin: grilling session 2026-10-05 (spec decision 8). "Fuzzy search / model add for device model (like how we already do SKU search)."

### 2026-10-05 — implemented

- **Web** (`web/src/components/ModelPicker.tsx`, new): the model-side twin of
  `SkuPicker`. It calls the SAME `searchSkus` ranker from
  `web/src/skuSearch.ts` over the models catalog (GET /api/models, which the
  batch page already fetches) — no algorithm copy; substring → all-words →
  word-prefix → subsequence and the codepoint/id tie-breaks behave
  identically for models and SKUs. Same keyboard contract as SkuPicker
  (Enter picks the highlighted row and never submits the surrounding
  add-device form; Escape closes; rows click-select). Reuses the
  `sku-picker` CSS classes — no new styles.
- **Inline create-if-missing**: when the search finds NOTHING, the list
  offers "Add "<name>" as a model"; the offer is intentionally NOT a
  permanent row (unlike SkuPicker's ticket-24 follow-up) — its job is to
  fill a gap, not to sit under matching results inviting a near-duplicate.
  Creation POSTs to the existing /api/models endpoint (server unchanged);
  `onCreated` hands the row to the caller, which merges it into its catalog
  list deduped by id.
- **409 duplicate path** (ModelPicker): the server dedupes
  case-insensitively, so a 409 means the model EXISTS. The picker shows the
  server's message loudly, refetches GET /api/models (the props catalog may
  be stale — another tech may have created the model after this page
  loaded), selects the case-insensitively matching row, and notes
  "selected the existing model". A 409 whose refetched catalog has no
  matching name is surfaced as an error, never silently resolved with a
  look-alike.
- **Model-driven SKU suggestions**: `SkuPicker` gains an optional
  `suggestFor` (the device's model name). SKUs matching the model via the
  same `matchTier` sort to the top of the results (with and without a typed
  query) and carry a "for <model>" badge. Nothing is hidden — the rest of
  the catalog stays listed below — because the schema has no model↔SKU
  compatibility table: the suggestion is a name match, and a hard filter
  would silently make generic SKUs (adhesive tape, etc.) unfindable on a
  device row.
- **Web** (`web/src/pages/BatchDetailPage.tsx`): the add-device modal's
  pick-or-type pair (Model `<select>` + "New model name" input) is replaced
  by one ModelPicker; `deviceForm.newModelName` and the `modelName` payload
  field are gone (the picker creates the model first, the device then
  references its id — the server's `resolveModel` name path is simply no
  longer exercised by this UI). The pre-attach SkuPicker in the same modal
  gets `suggestFor` from the chosen model, so picking a model immediately
  reshapes the suggestions. The device EDIT modal's Model field is the same
  ModelPicker (`onModelCreated` threaded through DeviceGrid).
- **Scope note / deviation**: the parts PANEL's add-part picker
  (`DevicePartsPanel`, `web/src/components/DeviceParts.tsx`) could not be
  given `suggestFor` — that file is off-limits this pass (concurrent
  ticket-02 territory). The capability ships in SkuPicker; wiring the parts
  panel is a one-prop change there once the file frees up.
- **Server**: no change needed — `server/domains/batches/models.ts` already
  does case-insensitive dedupe with a 409, and
  `server/tests/batches.test.ts` already covers create + exact-duplicate
  409, different-case 409, and the ordering contract; extended nothing to
  avoid duplicating it.
- **Tests** (`web/src/skuSearch.test.ts`, new describe): ranker-level
  coverage of the picker's use of the shared functions — model names through
  the four tiers, identical ordering/tie-breaks over a models catalog, and
  `matchTier` as the model→SKU suggestion predicate (model pulls its own
  parts, generic SKUs stay findable by query).
- **Docs**: `docs/logic-map.md` (POST /api/models row: the picker seam,
  409-refetch-select, suggestFor) and `docs/manual.md` (section 3: the
  searchable Model box, inline add, duplicate behavior; pre-attach
  suggestions; the edit form's same picker). CONTEXT.md needed no change —
  "models drive compatible part-SKU suggestions" already says this.
- **Verification**: `npm run typecheck` clean (server + web);
  `web/src/skuSearch.test.ts` 22/22; `server/tests/batches.test.ts` 35/35.
