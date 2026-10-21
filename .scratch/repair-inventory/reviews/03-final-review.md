# Final review — committed state `55dcd9d..HEAD`

Scope: everything since the first review round — ticket 06 (batch lifecycle + finding-D fix), the auth double-redeem fix (`7c467bc`), ticket 14 (part-status + timeline consolidation), ticket 15 (correctness fixes), ticket 13 (intake), ticket 12 (reports), ticket 18 (admin panel), tickets 16–17 (standing docs), the SKU kind/delete feature (`14acd15`), ticket 19 (DYMO Web Connect printing), ticket 20 (SKU picker), plus tickets 08/11 which landed inside the same range. 22 commits, ~16,100 insertions across 113 files. Tree clean, 315/315 green.

Method: both axes of the code-review skill run sequentially against `git diff 55dcd9d...HEAD` and `git show` of the changed files; spec axis checked per ticket against each ticket file's acceptance criteria in `.scratch/repair-inventory/issues/`; the prior reports (`01-code-review.md`, `02-architecture.md`) used as the fix-verification checklist; 12 sample claims from the freshly written standing docs audited against the code.

---

## Verdict

**PASS — ready for the human's ready-for-human sweep, with one Moderate consolidation gap and two doc corrections to fold in.**

Every prior Major finding and every ranked do-now architecture opportunity except one (arch C's *consolidation* half) is verifiably closed in committed code. The new code (admin panel, DYMO client, reports, intake, SKU picker) meets the review bar: destructive actions are backed up first, typed-confirmed, and console-logged; silent fallbacks were hunted and none found; the DYMO "200 with body false" trap was made loud. No Critical or Major findings this round.

---

## Standards axis

Sources: AGENTS.md (Review standard — single source of truth per rule, loud failure, explicit seams; silent fallbacks, existence-guessing, stubs, TODOs are defects), CONTEXT.md, ADR-0001 (portable SQL), plus the skill's smell baseline (repo conventions override; smells are judgement calls).

| # | Sev | Axis | Area | Finding | Evidence | Suggested fix | Cost |
|---|-----|------|------|---------|----------|---------------|------|
| F1 | **Moderate** | Standards | Demand seam (batchparts ↔ purchaseorders) | Architecture finding C was applied only by half: the `sqlite_master` probe died (S1 ✓) but the **duplicated outstanding-demand rule survives**. Two live functions answer "what is outstanding Need to Order demand" differently: `batchparts/queries.ts:371-373` returns every `status='open'` record **including ones already marked ordered on a PO**; `purchaseorders/demand.ts:54-85` subtracts `purchase_order_demand` links. Two endpoints serve them (`GET /api/demand`, `GET /api/purchase-orders/demand`); the client uses only the PO one (`web/src/pages/PurchaseOrderCreatePage.tsx:78`). One rule, two sources of truth, one dead-to-the-UI endpoint — the exact drift arch C predicted. | `server/domains/batchparts/queries.ts:371-373`; `server/domains/purchaseorders/demand.ts:54-85` | Fold the link-table subtraction into one definition (arch C's shape: batchparts owns the query, purchaseorders imports it) and drop or redirect `GET /api/demand`; the endpoint is unused by the client but still documented (see F2). | S |
| F2 | Minor | Docs | logic-map.md | The batchparts route table claims `GET /api/demand` is "the global outstanding demand queue **(what the PO form prompts from)**". The PO form fetches `/api/purchase-orders/demand`; `/api/demand` is the un-subtracted queue. The doc contradicts both the code and the same document's own PO-domain entry (line 240, which is accurate). | `docs/logic-map.md:325` vs `web/src/pages/PurchaseOrderCreatePage.tsx:78` | Correct the line (or delete it if F1 removes the endpoint). | S |
| F3 | Minor | Docs | data-model.md, migration 0006 comment | The "stepped database" rationale for `purchase_order_demand`'s deliberately missing foreign key survives in three places — `docs/data-model.md:377`, `docs/data-model.md:405`, and the migration 0006 comment — yet ticket 15 itself declared that scenario impossible ("the old migration-0006 comment … described a scenario the migration runner's strict ordering already makes impossible") and rewrote `demand.ts`'s doc comment accordingly. The doc now asserts a rationale the repo's own fix log says is false. | `docs/data-model.md:377,405`; `server/db/migrations/0006-purchase-orders.sql` (comment) | Update both doc lines to the real reason (decoupled FK, the runner's ordering is the contract); the migration comment can be corrected or left as a historical record — say which. | S |
| F4 | Minor (judgement) | Standards | Admin backup | `createBackup` removes any existing same-stamp file before backing up (`fs.rmSync(target, { force: true })`): two backups within the same second **silently replace** the earlier artifact in `data/backups`. It is documented in the comment as deliberate ("same-second collisions overwrite loudly rather than duplicating" — it is actually a silent overwrite, just of the tool's own output). The download stream means the user never loses their copy, but the "back up FIRST" danger rule can quietly lose a same-second on-disk artifact. | `server/domains/admin/backups.ts:71-77` | Add a collision counter suffix (monotonic `-2`, `-3`) or refuse with a message; either keeps the danger rule airtight. | S |
| F5 | Minor (judgement) | Standards | Admin clear | `POST /api/admin/clear` wipes, re-runs migrations, **then** re-provisions the bootstrap manager before logging and responding (`admin/index.ts:243-252`). If `provisionBootstrapManager` throws (a misconfigured `BOOTSTRAP_MANAGER_EMAIL`), the wipe has already happened but the API answers 500 and the `DATABASE CLEARED` console log never prints — loud, but the failure misreports what occurred. In practice the value is validated at startup so the window is near-nil; recording because a danger action whose response can contradict its effect is worth a comment or a try/announce. | `server/domains/admin/index.ts:243-252`; `server/domains/auth/index.ts:277-281` | Wrap provisioning so a failure is announced as "database cleared; bootstrap provisioning failed: …" and still answer with the backup name. | S |
| F6 | Minor (judgement) | Standards | SKU picker matcher | `searchSkus`'s alphabetical tie-break uses `localeCompare()` with no locale argument (`web/src/skuSearch.ts:110`), whose ordering follows the *runtime's default locale/ICU build*. The module's contract says "the same input always produces the same output" — true on one machine, not guaranteed across machines (shop PC vs dev box with different ICU). Pure module, so this is the one impurity. | `web/src/skuSearch.ts:110` | Compare code points (`<`/`>`) or pass an explicit locale (`"en"`); one-line change, add a tie-order pin test. | S |
| F7 | Note | Standards | Admin SQL console | Scrutinized for bypass and found clean: read-only default is a single-statement gate (`singleStatement` refuses anything containing `;`, loudly) plus a `^select\b` prefix check; write mode is per-session, typed-confirmed (`ALLOW WRITES`), and every non-SELECT execution takes an automatic pre-write backup; everything executed is console-logged with a timestamp; SQL errors return verbatim on purpose (the console exists to inspect and fix data). Multi-statement `exec` in write mode is the feature, backed up first. | `server/domains/admin/index.ts:337-407`; `server/domains/admin/sql.ts` | None. | — |
| F8 | Note | Standards | Admin auth separation | Clean: the admin domain never reads the app's `session` cookie, uses a dedicated `admin_session` cookie with in-memory tokens, constant-time key comparison (SHA-256 digests + `timingSafeEqual`), a 5/min/IP failure limiter, and a 404 catch-all when `ADMIN_KEY` is unset. Registered **first** in bootstrap so `/api/admin` is matched before the auth domain's session-gated `/api` router — the ordering constraint is stated as a contract in `bootstrap.ts:23-26`. | `server/domains/admin/auth.ts`; `server/bootstrap.ts:22-27` | None. | — |

**Smell-baseline notes (judgement calls, mostly suppressed by convention):** `badRequest` remains ×7 — the domain-self-containment convention endorses it, unchanged from round 1's S6 verdict. The admin domain's `fs`/`path` work is infrastructure, not domain logic — correctly isolated in `backups.ts`/`sql.ts`. No new speculative generality: the DYMO client's port-scan array mirrors the DYMO framework's own documented range, not an invented hook.

---

## Spec axis

| Ticket | Verdict | Notes |
|---|---|---|
| **06** batch approval, close, retriage | **Met** (with one documented deviation) | All endpoints exist with the specified guards (manager-only approve with required note + snapshotted approved total `lifecycle.ts:323-359`; close blocked until every device is terminal, naming non-terminal devices; retriage on "Additional issues present" in the same transaction with carry-over of reserved parts and open demands via batchparts-owned move functions, `lifecycle.ts:214-315`; cross-batch history by identifier). Post-approval tech restrictions and manager amendments are enforced server-side and serialized to the client as `partEditPermissions` / `allowedNextStatuses`. **Deviation:** acceptance box 3 is checked although "uninstalled reserved parts → Available at close" has no population in the schema (a part is Reserved only through an active attachment; removals pick their destination at removal time) — recorded honestly in the ticket's Comments. The checked box could mislead a checkbox-only reader (F-note; no code change). |
| **12** reports | **Met** | Five manager-only CSV endpoints with inclusive, loudly-validated `from`/`to` (`reports/index.ts:49-79`); RFC-4180 via csv-stringify; every report reads events only through the one timeline seam. The intake-source contract is honored: only `purchase-order` parts are expense lines, migration/salvage consumption is listed in a separate excluded section, and a NULL intake source **throws** rather than guessing (`reports/queries.ts:101-113`) — exactly the loud failure the standard demands. |
| **13** non-PO intake | **Met** | `parts/intake.ts` is the one non-PO writer; salvage is exactly-one-with-provenance (param-shape violations throw, route validates first); migration's `counted` is required (no silent default) and goes through the shared counting seam `applyCount` so audit due-ness treats it as a real count; PO receiving stamps `intake_source='purchase-order'`; migration 0013 backfills data-derived, not guessed. The nullable-column-plus-loud-readers design is documented with its WHY. |
| **18** admin panel | **Met** | All six features present; danger rules (backup first, typed confirmation, console log with timestamp) verified in code, not just claimed: clear (`index.ts:234-253`), restore (validates integrity + migration-prefix state, auto-backs-up current DB, staged swap at restart with a second validation, `backups.ts:87-129,169-228`), SQL write mode (`index.ts:318-407`). Restore rejected in-process hot-swap with a documented reason (prepared statements would strand on the dead handle) — a correct engineering decision, not a shortcut. Tests pin backup-before-clear ordering. |
| **19** DYMO printing | **Met** | The specific trap asked about — service answers HTTP 200 with body `false` for unknown printers — **is loud**: `dymoClient.ts:191-197` throws naming the printer and the service's exact answer. Service-down, non-200, unreadable-XML, and per-label failures each throw actionable messages; `printAll` stops at the first failure naming the serial and count reached. The framework-not-bundled decision is justified (license + 344 KB minified sync-XHR blob + no CDN dependency for offline shops) and the wire contract was verified against the live service, documented in the ticket. Manual verification checklist recorded. |
| **20** SKU picker | **Met** | The matcher is a pure, documented, tested module (`skuSearch.test.ts`, 18 tests); ranking tiers and tie-breaks are documented in the module header; deterministic within a runtime (see F6 for the one locale caveat). Applied at all four SKU-selection sites (`DeviceParts`, `IntakePage`, `CycleCountPage`, `PurchaseOrderCreatePage` — grepped, no legacy SKU dropdown remains). Zero-available rows visible and selectable per spec. |

**Cross-cutting spec decisions still honored in the new code:** single test seam (admin tests run at the HTTP seam including a real restart-swap scenario; no DB mocking found); injectable clock used for backup stamps and restore markers; money integer-cents; no wall-clock reads outside `clock.ts` except the two admin ops paths, each documented as ops-not-domain (`backups.ts:195-196`, `admin/index.ts:77`).

---

## Fix verification — every prior finding

| Prior finding | Status | Evidence |
|---|---|---|
| **S1** (Major) `demand.ts` `sqlite_master` probe / silent empty | **Closed** | `purchaseorders/demand.ts:14-17,39-46` — guards deleted, missing table = loud 500; tests pin 500 + no PO row on dropped table. |
| **S2** (Major) five part-status write sites, three guard disciplines; two holes | **Closed** | `parts/status.ts` is the one module; grep shows the only `UPDATE serialized_parts SET status` outside it is test setup. Hole (a): bare endpoint refuses in-transit-RMA parts (`status.ts:214-221`). Hole (b): audit close settles a Reserved part's attachment through the batchparts seam in the same transaction (`audits/index.ts:417-443` → `batchparts/queries.ts:617`). RMA complete uses `changePartStatus` guarded on `expectedFrom` (`rma/index.ts:490`); scan-wins likewise (`audits/counting.ts:176-186`). |
| **S3** (Moderate) `getSettingInt` NaN/0 | **Closed** | `parts/settings.ts:99-116` — throws on unknown key, wrong type, unparsable, below-min; default only for a missing row; comment states the actual contract. |
| **S4** (Moderate) `getBatchNumber ?? 0` | **Closed** | `batchparts/queries.ts:66-74` — throws "refusing to fabricate a batch number for the timeline". |
| **S5** (Moderate) two incompatible timeline event shapes | **Closed** | `auth/timeline.ts` — one shape (`actor: {id,email} \| null`), one serializer; client renders one shape (`web/src/components/Timeline.tsx:169`). |
| **S6** (Minor) label/serial/helper duplication | **Closed (as scoped)** | `normalizeSerial` ×1 (`parts/serials.ts:19`, imported by 5 domains); `PART_STATUS_LABELS` ×1 (`parts/status.ts:41`). `badRequest` ×7 remains — convention-endorsed, per round 1's own verdict. |
| **S7** (Minor) login-link enumeration 404 | **Not applied (optional)** | `auth/index.ts:145-147` still 404s. Was explicitly "acceptable, note only" for a ≤3-user internal tool; still fine. |
| **S8** (Minor) PO status CHECK admitting unimplemented states | **Closed** | Ticket 08's receiving/close implement them (`purchaseorders/receiving.ts`, close-with-shortfall). |
| **S9** (Minor) standing docs missing | **Closed** | Tickets 16/17 created `docs/logic-map.md`, `docs/data-model.md`, `docs/manual.md`; AGENTS.md duty now live. |
| **S10** (Minor) `serializeAuditDetail` re-reads | **Closed / moot** | Timeline reads collapsed into the one module; the remaining snapshot re-reads are unchanged and remain harmless. |
| Review-01 uncommitted-flag: root `bootstrap-manager.cjs/.js` direct-DB scripts | **Resolved** | Files never committed and now absent from the tree; ticket 18's panel is the reviewed provisioning/door (`provisionBootstrapManager` re-runs after clear). The `.env` loading and `0.0.0.0` bind were committed deliberately (`3bac5d4`) and are consistent with the LAN-shop spec. |
| **Arch A** one timeline read module + notes factory | **Closed** | `auth/timeline.ts:63-143`; five read paths → one (`timelineFor`/`timelineEvents` grep: 6 domains, no hand-rolled `LEFT JOIN users` left outside the module); three note endpoints → `registerNotesRoute` (batches:132, POs:344, rma:281). |
| **Arch B** one part-status module | **Closed** | Same as S2. Five importers; no raw status writes. |
| **Arch C** single outstanding-demand definition | **Partial — see F1** | Probe deleted (S1) but the duplicated rule and both endpoints remain; consolidation never landed. |
| **Arch D** close the `devices.repair_status` backdoor | **Closed** | `batches/lifecycle.ts:86-169` `setRepairStatus` (graph + approval gate + notes + event + retriage); the batches endpoint calls it (`batches/devices.ts:405`); batchparts' demand auto-move calls it (`batchparts/index.ts:310-317`); grep confirms no other writer. |
| **Arch E** portable-SQL sweep | **Closed** | `grep -ri "COLLATE NOCASE\|INSERT OR IGNORE\|sqlite_master" server/` is clean of domain-query uses; `sqlite_master` survives only in the admin domain's backup validation/system info, which operates on the database file itself — that is the SQLite adapter's territory, not a domain-query violation. Ticket 15 documented the remaining SQLite-ism (`LIKE` case folding) for the Postgres migration. |
| **Arch F** move money/settings out of parts | **Not applied (per its own verdict)** | "Do now or at handoff — either is fine." Still in `parts/`; the logic-map matrix documents the cross-imports honestly. Carry to handoff. |
| **Arch G** client renders statuses from the server graph | **Closed** | `batches/serialize.ts:157` serializes `allowedNextStatuses` (lifecycle-narrowed via `statuses.ts:71-83`); BatchDetailPage renders from the response. |
| **Arch H** Postgres sequences for human numbers | **Not applied (at-handoff task)** | Correctly deferred; the sequential-number sites are unchanged. |

---

## Docs accuracy spot-check (12 claims audited)

| # | Claim (doc) | Verdict |
|---|---|---|
| 1 | Device Repair Status graph, logic-map:164-172 | ✓ Matches `batches/statuses.ts:42-50` exactly, incl. "Parts needed → In progress" only. |
| 2 | `serialized_parts.status` CHECK values, data-model:148 | ✓ Matches migration 0003. |
| 3 | `rma_order_parts` settlement all-or-nothing CHECK, data-model:440-442 | ✓ Matches migration 0007. |
| 4 | `nextPartId` = max(parts.id, claims.id) + 1, data-model:497-499 | ✓ `parts/serials.ts:29-37`. |
| 5 | Sessions have no server-side expiry, data-model:102-104 | ✓ `auth/session.ts` comment + code (cookie caps at 400 days). |
| 6 | Search: SKU case-insensitive substring, identifiers exact, `#29`/`29` both work, logic-map:381 | ✓ `search/index.ts` (LOWER LIKE with ESCAPE; LOWER =; number prefix strip). |
| 7 | Each status column has exactly one writer (data-model invariant 6) | ✓ Verified by grep: `serialized_parts.status` → `parts/status.ts` only; `devices.repair_status` → `setRepairStatus` only; `batches.status` → lifecycle approve/close only; `purchase_orders.status` → approve, receiving recompute, shortfall close; `rma_orders.status` → complete. |
| 8 | Admin routes table incl. rate limit, danger ordering, 404-when-unset (logic-map:53-69) | ✓ Matches `admin/index.ts` + `admin/auth.ts`. |
| 9 | "PO receipt refreshes price … recorded even when unchanged", data-model:136-139 | ✓ `purchaseorders/receiving.ts:363-366`. |
| 10 | Audit scan-wins with required note, logic-map:355 | ✓ `audits/counting.ts:148-189` + route-level note requirement (`audits/index.ts:43,361,507`). |
| 11 | "`GET /api/demand` … what the PO form prompts from", logic-map:325 | ✗ **Wrong** — the PO form uses `/api/purchase-orders/demand` (F2). |
| 12 | `purchase_order_demand` has no FK because migrations may apply out of step, data-model:377,405 | ✗ **Stale** — the rationale ticket 15 refuted; the migration 0006 comment carries the same false rationale (F3). |

Score: 10/12 accurate; the 2 misses are the doc corrections F2/F3.

---

## Summary

- **Standards axis:** 6 findings — 0 Critical, 0 Major, 1 Moderate (**F1**, the surviving demand-rule duplication — arch C's consolidation half), 5 Minor (F2–F6, three of them doc corrections or recorded judgement calls). Worst: **F1**.
- **Spec axis:** 0 failures across tickets 06, 12, 13, 18, 19, 20. One recorded note (ticket 06's checked box vs its documented deviation) and one carry-forward (arch F/H at handoff).
- **Fix verification:** all four code-review findings with required fixes closed in committed code; all five do-now architecture opportunities closed except arch C (partial — the probe died, the duplicate rule lives on, tracked as F1). The uncommitted bootstrap scripts flagged in round 1 never landed and are gone.
- **Docs:** standing docs are genuinely derived from the code (10/12 spot-checks pass); the two misses are cheap line edits.

**Recommended before final sign-off:** F1 (S), F2 (S), F3 (S). F4–F6 are polish; batch them into a follow-up ticket if desired.
