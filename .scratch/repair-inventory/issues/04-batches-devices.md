# 04: Batches and devices

**What to build:** The batch record as it replaces the spreadsheet — without parts yet. A tech creates a Batch with a required opening note; the batch gets a sequential human number (#29 style). Device rows carry Model (picked from a maintained, tech-extendible list), Capacity, at least one identifier (IMEI, Asset ID, or serial — with a non-blocking warning when an IMEI already exists), Stated Issue, cosmetic/PCL/MDM notes, Repair Time (hand-entered), Repair Status (Awaiting repair → In progress → QA → Repaired / Unrepairable, plus Parts needed and Additional issues present), and Resolution notes at terminal states. Triage Date auto-sets and Assigned Tech defaults to the creator. The batch's displayed state is derived from its devices (counts per status) — never stored as a second, hand-edited status. Notes and system events merge into one immutable chronological timeline per batch.

**Blocked by:** 02 (auth, users, and roles). Independent of 03 — do not touch the parts domain.

**Status:** ready-for-human

- [x] Batch creation requires an opening note and auto-assigns a sequential number; batches are listable with derived per-status device counts
- [x] Device rows enforce at least one identifier; a duplicate IMEI returns a visible warning without blocking; every device edit and status change records an event; Resolution notes are required when reaching Repaired or Unrepairable
- [x] Device status transitions follow the allowed graph (no skipping into terminal states from nothing, no leaving terminal states on the same batch)
- [x] The Model list is maintained and tech-extendible (adding a model from the device form, with an event)
- [x] The batch timeline shows typed notes and system events merged, chronological, immutable (no edit/delete endpoints exist)
- [x] Batch UI: create with required note, device grid matching the spreadsheet columns, per-batch timeline, device status editing
- [x] API tests cover required-note creation, identifier validation, duplicate-IMEI warning, the status graph, and timeline immutability

## Comments

**What exists** (all under `server/domains/batches/`, migration `0004-batches.sql`, tests `server/tests/batches.test.ts`, web pages `BatchesPage` + `BatchDetailPage`):

- **Migration 0004**: `batches` (id, sequential `number`, created_at/by — deliberately NO status column), `devices` (spreadsheet columns + CHECK on `repair_status` vocabulary), `device_models` (maintained list). Parts/cost/approval columns are intentionally absent — clean seams for ticket 05.
- **Endpoints** (session-gated, on the auth domain's `/api` router):
  - `POST /api/batches` — requires non-empty opening note → `batch.created` + first `note.added` events; sequential number from `MAX(number)+1` inside a transaction.
  - `GET /api/batches` — list (newest first) with derived per-status `deviceCounts` + `deviceTotal`.
  - `GET /api/batches/:id` — detail incl. full device rows.
  - `POST /api/batches/:id/notes`, `GET /api/batches/:id/timeline` — timeline = events for the batch OR its devices, ordered by id (chronological). No edit/delete endpoints exist anywhere, by design.
  - `POST /api/batches/:id/devices` — device create; at least one identifier required (400 otherwise); duplicate IMEI → 201 with `warnings: [...]` (non-blocking); Triage Date auto-set from the clock; Assigned Tech defaults to creator, validated active otherwise; model by `modelId` or create-if-missing `modelName` (records `model.created`); devices always start `Awaiting repair`.
  - `PATCH /api/batches/:id/devices/:deviceId` — partial field edit (omitted = unchanged; invariants enforced on the MERGED row); records `device.edited` with old→new per changed field; sending `repairStatus` here → 400 (graph must go through the status endpoint).
  - `POST /api/batches/:id/devices/:deviceId/status` — the graph arbiter (below); resolution notes required for terminal targets.
  - `GET /api/models`, `POST /api/models` — maintained model list; POST records `model.created`, duplicate name → 409.
- **Status graph (server-enforced, 409 on violation)**: Awaiting repair → {In progress, Parts needed}; In progress → {QA, Parts needed, Repaired, Unrepairable, Additional issues present}; QA → {In progress, Parts needed, Repaired, Unrepairable, Additional issues present}; Parts needed → {In progress}; terminal (Repaired, Unrepairable, Additional issues present) → nothing. Terminal targets require non-empty resolution notes (400). Same-status POST is a 200 no-op with no event. `Parts needed` is fully wired now so ticket 05 can auto-set it.
- **Events**: `batch.created`, `note.added`, `device.created`, `device.edited`, `device.status_changed`, `model.created` — all through the shared `recordEvent` (auth domain), so typed notes and system events share one immutable timeline.
- **UI**: `BatchesPage` (create-with-note form, list with derived counts), `BatchDetailPage` (`/batches/:id`): device grid with the spreadsheet's columns, per-row status control offering only graph-legal next statuses with a resolution-notes field for terminal targets, device edit form, add-device form with new-model field, and the timeline. Route registered in `web/src/main.tsx`; small additive CSS appended to `styles.css`.

**Deviations / notes:**
- "Resolution notes required at terminal states" is enforced for all three terminal statuses (Repaired, Unrepairable, AND Additional issues present), per the ticket text; the checkbox named only the first two.
- The graph is strict-linear on the main path: Awaiting repair cannot jump straight to QA (only In progress / Parts needed); In progress MAY skip QA into a terminal status (work happened, so it isn't "from nothing"). QA can bounce back to In progress (failed QA) and can enter Parts needed.
- Assigned Tech reassignment in the edit form is a numeric user-id input (the user list API is manager-only, so techs can't browse ids). The API fully supports reassignment; a nicer picker can come later.
- Parallel-safety: my bootstrap.ts and web-router lines landed inside the 03 agent's commit (`ec02d6e`) after a read-modify-write clash dropped my registry line mid-flight — re-added and verified present in HEAD alongside theirs. Full suite (92 tests, 5 files) green at commit time.
