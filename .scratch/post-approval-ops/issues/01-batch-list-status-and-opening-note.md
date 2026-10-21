# 01 — Batch list: fix blank Status column + opening-note column

Status: ready-for-human
Labels: ready-for-human

## Problem

On `/batches/` every row's Status cell renders blank. Root cause (confirmed): the list route at `server/domains/batches/index.ts:73-82` carries its own ad-hoc SELECT that omits `b.status` — and `approved_at`, `approved_by`, `approved_cost_cents`, `closed_at`, `closed_by` — then casts the rows `as BatchRow` and calls `serializeBatchSummary`, which reads the missing fields as `undefined`. JSON.stringify drops the keys; the client (`web/src/pages/BatchesPage.tsx:109`, `{batch.status}` with no falsy guard) renders nothing. The type cast lies; five more fields silently vanish from every list payload.

## Work

1. Route the list query through the shared `BATCH_SELECT` (`server/domains/batches/serialize.ts:189-200`) — one query, one source of truth. Preserve the `ORDER BY b.number DESC`.
2. Add a **new column immediately after Batch** in `BatchesPage.tsx`: the batch's **opening note** (the note captured at creation; it lives as a timeline event, not a batch column — `POST /api/batches` requires it, see `lifecycle.ts` `createBatchRecord`). Truncate to one line; full text on hover (`title` attribute or equivalent).
3. Expose `openingNote` on the batch summary serialization (fetch the batch's first/creation note event per batch — do not guess by ordering heuristics without checking how creation notes are recorded in the events table; the event that `createBatchRecord` writes is the source).
4. No silent fallbacks: if a summary somehow lacks `status`, fail loud (per repo review standard), don't render blank.

## Acceptance

- Status column shows `Awaiting approval` / `Open` / `Closed` for every batch.
- Opening-note column shows the creation note, truncated with full text on hover.
- List payloads include `status`, `approvedAt`, `approvedBy`, `approvedCostCents`, `closedAt`, `closedBy`.
- Tests cover the list serialization fields.

## Doc obligations

- `docs/logic-map.md`: batches routes entry if the list endpoint's data source changes shape.
- `docs/data-model.md`: note where the opening note is sourced from if a new read seam is added.

## Comments

- Origin: grilling session 2026-10-05 (`.scratch/post-approval-ops/spec.md` decision 4, defect note). User screenshot confirmed all rows blank; DB values verified correct (`data/repair-inventory.sqlite`, all five batches carry proper statuses).

### 2026-10-05 — implemented

- **Server** (`server/domains/batches/index.ts`): the list route's ad-hoc
  SELECT is gone — it now runs the shared `BATCH_SELECT` (exported from
  `serialize.ts`) + `ORDER BY b.number DESC`, so list and detail share one
  query and the `as BatchRow` cast is honest. The five silently-dropped
  fields (`status`, `approved_at/by/cost_cents`, `closed_at/by`) ride every
  list payload again.
- **Server** (`server/domains/batches/serialize.ts`):
  - `serializeBatchSummary` now fails loud when a row has no `status`
    (defensive invariant — unreachable through `BATCH_SELECT`, same shape as
    the `approveAllDevices` defensive check).
  - New `openingNote` field, sourced by `openingNoteFor`: the batch's FIRST
    `note.added` event — the one `createBatchRecord` writes inside the
    creation transaction, before the batch id can be referenced by anything
    else, so "first note.added for the batch entity" is the documented write
    path, not an ordering guess. A missing event or a payload without text
    throws (every batch is created through `createBatchRecord`, so a missing
    note is an inconsistency, not a variant).
- **Web** (`web/src/pages/BatchesPage.tsx`, `web/src/styles.css`): new
  **Opening note** column immediately after Batch — one line via
  `.opening-note-cell` (nowrap + ellipsis, max-width 18rem), full text on
  hover through the `title` attribute.
- **Tests** (`server/tests/batches.test.ts`, new describe): list payloads
  carry `status`/`approvedAt`/`approvedBy`/`approvedCostCents`/`closedAt`/
  `closedBy` before and after approve+close; `openingNote` is the CREATION
  note even after later notes are added; a batch row inserted behind
  `createBatchRecord`'s back (no note event) makes the list fail loud (500).
- **Docs**: `docs/logic-map.md` (GET /api/batches row),
  `docs/data-model.md` (batches invariant: the opening note is the first
  `note.added` event, deliberately not a column), `docs/manual.md`
  (section 3: what the Batches list shows).
- **Verification**: `npm run typecheck` clean; `batches.test.ts` 35/35; full
  suite 472/474 — the 2 failures (`device-removal.test.ts` "cancelled demand
  cannot be marked ordered…", `batchparts.test.ts` "is listable per batch and
  globally outstanding") reproduce on a clean stash of this ticket's changes,
  i.e. pre-existing on HEAD and in tickets 09/10's territory (PO-receipt
  auto-reserve hardening), not this ticket's. Production DB spot-check: all
  five batches carry a first `note.added` event and a proper status, so the
  live list renders fully.
