# Architecture review — committed state 55dcd9d

Scope: `git show 55dcd9d:<path>` only (tickets 06, 08, 11 are in flight in the working tree and are excluded from all findings). Method: the improve-codebase-architecture skill (deep/shallow modules, seams, deletion test) using the codebase-design vocabulary and CONTEXT.md domain language. Committed domains: auth, batches, parts, batchparts, purchaseorders, rma, audits, health. ~182 tests at the single HTTP seam.

---

## 1. Module dependency map

### 1.1 Import graph (who imports whom)

```
                     domain.ts (AppContext: db + clock)
                                 ^
   ┌───────────────┬─────────────┼──────────────┬──────────────┐
   auth ───────────┼─────────────┼──────────────┼──────────────┤
 (session-gated /api router via app.locals;                    │
  recordEvent; requireManager; CurrentUser)                    │
   │    │    │    │        │            │             │        │
   │    │    │    │        │            │             │        │
 batches  parts  batchparts  purchaseorders  rma  audits  health
   │        │  ←─────────────┤  ←── prices ──┤  ←── prices
   │        │  ← prices, ────┤  ←── prices ─┘       ←── prices
   │        │    statuses ───┤              ← settings (schedule)
   │        │                │
 (batches/statuses ─→ batchparts: TERMINAL_STATUSES, RepairStatus)
 (parts/prices  ─→ batchparts, purchaseorders, rma)
 (parts/settings ─→ audits/schedule)
 (auth/events.recordEvent ─→ every domain; auth/session.require* ─→ several)
 (auth/index.getApiRouter ─→ every domain)
```

Every domain imports the auth domain three ways: `getApiRouter` (the session-gated `/api` router, handed over through `app.locals`), `recordEvent` (timeline writes), and `requireManager`. **auth is the shared kernel**, and this is deliberate and documented (`server/domains/auth/index.ts:44-56`). It is the deepest seam in the codebase: one registration-order rule with loud failure (`auth/index.ts:85-90`).

### 1.2 Cross-domain table touches (the drift hazards)

Table ownership vs. actual readers/writers at 55dcd9d:

| Table (owner) | Other domains touching it | Touch | Explicit contract? |
|---|---|---|---|
| `serialized_parts` (parts) | batchparts | **write** (guarded `WHERE status='available'` / `WHERE status='reserved'`, `batchparts/queries.ts:104,118`) | commented, guarded — the best of the lot |
| `serialized_parts` (parts) | rma | **write** (unguarded `UPDATE … SET status='unavailable'`, `rma/index.ts:541`) | comment only, no guard |
| `serialized_parts` (parts) | audits | **write** ×2 (unguarded, `audits/index.ts:446` no-grace failure; `audits/counting.ts:177` scan-wins restore) | comment only, no guard |
| `devices` (batches) | batchparts | **write** (`UPDATE devices SET repair_status='Parts needed'`, `batchparts/index.ts:239`) — bypasses the batches status endpoint and its graph | comment claims consistency with `statuses.ts`; nothing enforces it |
| `demand_records` (batchparts) | purchaseorders | read (`demand.ts`), via a `sqlite_master` existence probe; **re-implements** the "outstanding" rule differently | documented as a seam, but it duplicated the rule (see §3, opportunity C) |
| `rma_orders`, `rma_order_parts` (rma) | audits | read (`counting.ts:onInTransitRma`) for the in-transit exemption | commented ("ticket 09's real check") but direct SQL, no interface |
| `skus` (parts) | batchparts, purchaseorders, rma, audits | read | fine — catalog reads are naturally shared |
| `users` (auth) | everyone | read (joins for emails) | fine |

**Pattern:** reads across domains are pervasive and mostly benign; every *write* across a domain seam is an implicit contract living in a comment. One of them (`purchaseorders` vs. `demand_records`) has already drifted: two live endpoints answer "what is outstanding Need to Order demand" differently (see below).

### 1.3 Duplicated domain rules (the same rule written twice or more)

| Rule (CONTEXT.md concept) | Copies in committed state |
|---|---|
| Timeline **read** path (`SELECT … FROM events e LEFT JOIN users … ORDER BY e.id`) | ×5: `batches/index.ts:28` (TIMELINE_SELECT, plus devices subquery), `parts/index.ts:234`, `purchaseorders/serialize.ts:80` (poEvents), `rma/index.ts:180`, `audits/index.ts:158` |
| Event JSON **shape** | ×2 and *incompatible*: `batches/serialize.ts:159` and `purchaseorders/serialize.ts:80` emit `actor: {id, email}`; `parts`, `rma`, `audits` emit `actor: "<email>"`. The web client carries both interfaces and three bespoke renderers (`BatchDetailPage`, `PurchaseOrderDetailPage`, `RmaDetailPage`) alongside the shared `components/Timeline.tsx` |
| `note.added` POST endpoint (validate → 404 → transaction → recordEvent → return event) | ×3: `batches/index.ts:107`, `purchaseorders/index.ts:337`, `rma/index.ts:331` |
| Part status labels (Available/Reserved/…/Damaged by Tech) | ×4: `parts/index.ts:43`, `batchparts/queries.ts:17` ("mirrored; the parts domain keeps its own"), `rma/index.ts:246`, `audits/counting.ts:21` |
| Part status write + `part.status_changed` event recording | ×5 sites with three different guard disciplines (guarded SQL in batchparts; handler-level checks in parts; unguarded in rma and audits) |
| Repair Status graph (Awaiting repair → … terminal) | ×2: `batches/statuses.ts` (authoritative, server-enforced) and `web/src/pages/BatchDetailPage.tsx:29-42` (`REPAIR_STATUSES`, `TERMINAL_STATUSES`, `NEXT_STATUSES` re-declared to render buttons) |
| "Outstanding Need to Order" | ×2, **semantically different**: `batchparts/queries.ts:371` (`status='open'` only, served at `GET /api/demand`) vs. `purchaseorders/demand.ts:70` (open minus PO-linked, served at `GET /api/purchase-orders/demand`). The client's PO form uses the purchase-orders one; `GET /api/demand` is not referenced anywhere in `web/` |
| Sequential human number (`COALESCE(MAX(number),0)+1`) | ×3: `batches/index.ts:61`, `purchaseorders/index.ts:133`, `rma/index.ts:273` |
| `normalizeSerial` | ×4 domains (parts, batchparts, rma, audits) |
| Money formatting in the client | ×2+ ad hoc: `DeviceParts.tsx:67`, `RmaPage.tsx:180`, inline `.toFixed(2)` in `PurchaseOrderDetailPage.tsx:209,330`, `RmaDetailPage.tsx:419` |

### 1.4 Where the seams already are deep (keep these — deletion test passes)

- **`auth/events.ts:recordEvent`** — the timeline write path. Six-field interface, hides the insert, clock stamping, and JSON encoding. Delete it and the same insert reappears in ~10 call sites. This is the model the read path should copy.
- **`server/clock.ts`** — one method, two adapters (`systemClock`, `FakeClock` in the harness). A real seam, used exactly as the spec requires.
- **`auth/email-plug.ts`** — one-method interface, one production adapter (logging) plus the test surface; the SMTP adapter is pre-justified by the spec. A correct hypothetical seam.
- **`batches/statuses.ts`** — the Repair Status graph as data plus `transitionError`. Right shape; its problems are the client copy and the batchparts backdoor, not the module.
- **`audits/counting.ts:applyCount`** — one scan path behind a `CountContext` union, audit and cycle-count callers thin. Good deepening; note it is *itself* a cross-domain writer into `serialized_parts`, which is why it should sit on a shared part-status module (opportunity B).
- **`audits/schedule.ts`** — pure UTC calendar math; deep and well-commented.
- **`parts/prices.ts`** — genuinely single-source money handling (parse/format), correctly integer-cents. Its only defect is *where it lives* (inside the parts domain).

---

## 2. What is shallow or leaking

**The timeline is the codebase's most-rewritten concept.** CONTEXT.md makes Note/timeline a first-class concept ("one immutable timeline per batch, PO, and RMA order"), the write side is one deep module, but the read side is five hand-rolled queries, two incompatible JSON shapes, three near-identical note endpoints, and three client renderers plus a fourth shared one that only works for the email-string shape. A dev team member changing timeline presentation or payload handling must find and edit ~10 files.

**The part lifecycle is the codebase's least-owned rule.** The Serialized Part status graph is the heart of inventory accountability (shrink = audit failures + Damaged by Tech; RMA recovery = unavailable-on-complete), yet no module owns it. Labels are copied four times; the five write sites enforce three different disciplines. The parts domain refuses reserved↔reserved transitions at the handler; batchparts guards in SQL; rma and audits don't guard at all (they rely on order/window state checked earlier in the same request). Nothing structurally prevents a future writer from, say, flipping a Reserved part to Available, which would break the "a part becomes Reserved only through a Batch" invariant that today is only enforced by *two* of the five write sites.

**The web client is a thin consumer — with one real leak.** Money/statuses/labels all come from the server; computed values (Parts Cost, device counts) are server-computed. The leak is `BatchDetailPage.tsx:29-42`: the full Repair Status transition table re-implemented client-side to render the status dropdown. Ticket 06 (approval gating, in flight) is precisely the change that will make the server graph diverge from the client copy — the client would offer transitions the server refuses, or stop offering ones it now allows.

**Portable-SQL violations (ADR-0001: "no SQLite-only SQL features").** Four, all in committed query text:

1. `purchaseorders/demand.ts:42` — `SELECT 1 FROM sqlite_master` (Postgres: no such table; the guarded probe fails-closed as "no demand").
2. `batches/models.ts:27` and `parts/index.ts:290` — `COLLATE NOCASE` (a SQLite built-in collation; Postgres errors unless a collation named `nocase` exists).
3. `purchaseorders/index.ts:181` — `INSERT OR IGNORE` (SQLite syntax; Postgres is `ON CONFLICT DO NOTHING`).

Each is small, but the migration path *is the pitch* per ADR-0001, and a fail-closed `sqlite_master` probe would silently disable demand validation after a naive port — the worst kind of drift.

---

## 3. Ranked opportunities (benefit ÷ cost)

Verdict scale: **do now** (solo-maintainer-compatible, no rework risk), **do at handoff** (when the dev team takes over), **leave alone**.

### A. One timeline read module + one note-endpoint factory — rank 1

- **Friction today (concrete, committed state):** five read paths (`batches/index.ts:28`, `parts/index.ts:234`, `purchaseorders/serialize.ts:80`, `rma/index.ts:180`, `audits/index.ts:158`); two incompatible event JSON shapes (`batches/serialize.ts:159` actor object vs. `parts/index.ts:251` actor email string); three copy-paste note endpoints (`batches/index.ts:107`, `purchaseorders/index.ts:337`, `rma/index.ts:331`); three bespoke client renderers (`web/src/pages/BatchDetailPage.tsx`, `PurchaseOrderDetailPage.tsx`, `RmaDetailPage.tsx`) alongside a shared `components/Timeline.tsx` that only understands one shape. Same change, ten files.
- **Change proposed:** extend `auth/events.ts` (or sibling `auth/timeline.ts`) with `timelineFor(db, entityType, entityId)` (one shape — the `{id, email}` actor object, matching the richer of the two), plus a `registerNotesRoute(router, ctx, {entityType, entityExists, notFoundMessage})` factory the three domains call. Domains keep their routes; the implementation concentrates. Client: one `TimelineEntry` type, one renderer.
- **Adaptability benefit:** the Note concept gets locality — a timeline presentation change or a payload change is one file server-side, one component client-side. Tests at the HTTP seam survive untouched (they assert shapes, which stay as-is per shape; the *inconsistent* shape is the one deliberate break, and it breaks loudly at both server tests and client, which is the point).
- **Cost: S–M** (a day: move code, unify shape, fix the client renderers, update affected tests).
- **Risk:** low. Pure consolidation; the two-shape fix touches committed tests that assert the email-string shape (parts, rma, audits tests) — mechanical updates. Coordinate with ticket 06/08 agents only if they add new timeline reads (they likely will — batch close events, receipt events).
- **Verdict: do now.**

### B. One part-status module (labels + guarded transitions + event recording) — rank 2

- **Friction today:** labels ×4 (`parts/index.ts:43`, `batchparts/queries.ts:17`, `rma/index.ts:246`, `audits/counting.ts:21`); status writes ×5 with three guard disciplines; the "Reserved only through a Batch" invariant enforced at only two of five sites. A dev team adding a status or a rule (say, "Damaged by Tech requires an attribution user") must find five write sites in four domains; miss one and the invariant silently leaks — exactly the "unexpected behavior between seams" the review is hunting.
- **Change proposed:** a `parts/statuses.ts` mirroring the shape that already exists for devices (`batches/statuses.ts`): the status vocabulary, `PART_STATUS_LABELS`, and a guarded `changePartStatus(db, clock, actor, {partId, to, note, expectedFrom?})` that does the conditional UPDATE (guarded like `batchparts/queries.ts:104`), records `part.status_changed`, and returns success/failure. The parts status endpoint, RMA complete, audit close, and `applyCount`'s scan-wins all call it. batchparts' reserve/release pair can adopt the same guarded-update helper.
- **Adaptability benefit:** the inventory-accountability rule gets a single source of truth and a single test surface. New writers (ticket 08's receiving auto-reservation is one!) get the rule for free instead of copy-pasting an unguarded UPDATE.
- **Cost: M** (2–3 days including test moves; the HTTP-seam tests already assert outcomes, so most survive).
- **Risk:** low-medium. Must be done transaction-composably (all call sites are inside `db.transaction`, and better-sqlite3 transactions nest fine). **Coordinate with ticket 08** (receiving writes part statuses) — land this before or with it, not after.
- **Verdict: do now** (labels consolidation immediately; write-site migration incrementally, 08 first).

### C. Delete the duplicated outstanding-demand query and the `sqlite_master` probe — rank 3

- **Friction today:** two live, *different* answers to "outstanding Need to Order": `batchparts/queries.ts:371` (open, served at `GET /api/demand`, unused by the client) vs. `purchaseorders/demand.ts:70` (open minus PO-linked, served at `GET /api/purchase-orders/demand`, used by the PO form). Plus `demand.ts:42` probes `sqlite_master` — a SQLite-only table (ADR-0001 violation) implementing a silent existence-guessing fallback that AGENTS.md explicitly calls a defect. Migrations apply in strict order (the runner enforces 0005-before-0006), so the guarded path guards nothing real.
- **Change proposed:** move the link-table subtraction into `batchparts/queries.ts:listOutstandingDemand` so both endpoints agree; `purchaseorders` imports it (read-only import precedent: rma imports `parts/prices.js`); delete `demand.ts`. Optionally drop or redirect `GET /api/demand` — pick one endpoint for the concept.
- **Adaptability benefit:** one definition of the demand rule; the portability landmine disappears; the client stops needing to know which endpoint has the truth.
- **Cost: S** (half a day).
- **Risk:** low. Behavior change is intended: `GET /api/demand` currently shows demand already ordered on an in-transit PO. **Coordinate with ticket 08** (receipt flips demand to fulfilled and reads these queries).
- **Verdict: do now.**

### D. Close the devices backdoor: batchparts writes `repair_status` directly — rank 4

- **Friction today:** `batchparts/index.ts:239` runs `UPDATE devices SET repair_status='Parts needed'` inside the demand transaction, bypassing the batches domain's status endpoint, its `transitionError` graph, and its event-recording shape (batchparts re-implements the `device.status_changed` event two lines later). It is consistent *today* only because a comment says so. Ticket 06 (approval gating and retriage, in flight right now) is exactly the change that installs new guards on device status — a backdoor that skips them is a drift time-bomb.
- **Change proposed:** `batches/statuses.ts` (or a small `batches/devices.ts` export) gains `setRepairStatus(db, clock, actor, {deviceId, to, reason})` — graph-checked, event-recording, transaction-composable. The batches endpoint and the batchparts auto-move both call it.
- **Adaptability benefit:** the approval rule lands in one place and cannot be bypassed by the demand path; the Repair Status graph's locality becomes real.
- **Cost: S–M** (half a day to a day).
- **Risk:** low, but **sequencing matters**: ticket 06 is editing this exact area. Either fold this into ticket 06's spec (preferred) or land it immediately after 06 merges. Don't do it concurrently.
- **Verdict: do now, sequenced with ticket 06.**

### E. Portable-SQL sweep — rank 5

- **Friction today:** `batches/models.ts:27` and `parts/index.ts:290` (`COLLATE NOCASE`), `purchaseorders/index.ts:181` (`INSERT OR IGNORE`), `demand.ts:42` (covered by C). ADR-0001's dump-and-load pitch fails on first contact with these.
- **Change proposed:** replace `COLLATE NOCASE` with `ORDER BY LOWER(name)` (portable), `INSERT OR IGNORE` with `INSERT … ON CONFLICT (po_id, demand_id) DO NOTHING` (portable, matches the UNIQUE constraint), and delete the probe per C.
- **Adaptability benefit:** the migration path becomes real rather than aspirational; nothing else changes.
- **Cost: S** (an hour plus tests).
- **Risk:** none; semantics identical. Note `openDatabase`'s `PRAGMA` lines are fine — they *are* the SQLite adapter, which is the one place SQLite-specific knowledge is allowed to live.
- **Verdict: do now** (models.ts and parts/index.ts touch points are outside ticket 06/08/11's core files; purchaseorders/index.ts:181 overlaps ticket 08 — coordinate).

### F. Move cross-cutting modules out of the parts domain (money, settings) — rank 6

- **Friction today:** `parts/prices.ts` is the money module (integer cents parse/format) but lives inside parts; `purchaseorders`, `batchparts`, `rma` import a sibling domain for a cross-cutting concern. `parts/settings.ts` + the `GET/PATCH /api/settings` routes own app-wide settings, including `audit_interval_months`, which is an audits-domain knob that audits reads via `audits/schedule.ts:2` importing from parts. A dev team member tracing "who owns audit cadence configuration" lands in the parts domain — the dependency map lies.
- **Change proposed:** move `prices.ts` → `server/money.ts`; move `settings.ts` → `server/settings.ts`; re-home the settings routes (a `settings` domain registration in `bootstrap.ts`, following the existing one-line registry rule).
- **Adaptability benefit:** honest module boundaries; search/reports domains (tickets 11/12) import infrastructure, not "parts". Small but compounding locality win.
- **Cost: S** (half a day; pure moves plus import updates; the registry gets two one-line edits).
- **Risk:** merge conflicts with concurrent tickets are the only real risk; prices.ts is imported by all three in-flight areas' neighborhoods but the file itself is stable.
- **Verdict: do now or at handoff — either is fine; it gets more valuable as domains multiply.**

### G. Un-duplicate the client's status graph — rank 7

- **Friction today:** `web/src/pages/BatchDetailPage.tsx:29-42` re-declares the full Repair Status graph. If ticket 06 changes the graph (approval gating, retriage), the client copy drifts silently: buttons that 409, missing buttons.
- **Change proposed:** the server already owns the graph — have `serializeDevice` include `allowedNextStatuses` (from the same `ALLOWED_TRANSITIONS` table), and the client renders options from the response. One line of truth; the client stops predicting the server.
- **Adaptability benefit:** approval gating and future status rules need zero client changes beyond rendering.
- **Cost: S.**
- **Risk:** none mechanically, but **ticket 06 is editing BatchDetailPage right now** — do this *after* 06 lands, folded into its client work if possible.
- **Verdict: do now-but-after-06** (it is the one client fix that matters; the client `formatMoney` duplication is cosmetic and can wait for the dev team).

### H. Sequential-numbering helper — rank 8

- **Friction today:** `COALESCE(MAX(number),0)+1` ×3 (`batches/index.ts:61`, `purchaseorders/index.ts:133`, `rma/index.ts:273`). Safe under SQLite's single writer; under Postgres with concurrent writers it is a duplicate-key error factory.
- **Change proposed:** none now in code — extract a `nextNumber(db, table)` helper if touched for other reasons; **document in the migration notes** that Postgres wants sequences/`IDENTITY` for the three `number` columns (the UNIQUE constraints already exist, which is the right loud failure).
- **Cost: S.**
- **Risk:** none.
- **Verdict: do at handoff** (a Postgres migration task, not a prototype task).

---

## 4. Reality check

**Solo non-developer maintainer.** Every recommendation above is consolidation, not new architecture: no framework, no new build step, no repository layer, no dependency injection container. A through E each finish inside a day or two, are verified by the existing HTTP-seam tests, and *reduce* the number of places a future change touches — which is the only kind of refactor that pays off for someone who doesn't read code for a living. The domain-folder convention, explicit bootstrap registry, numbered migrations, and single test seam all stay exactly as the spec fixed them.

**Dev-team pitch ("can I change one domain without spelunking?").** Today the honest answer is: writes yes-ish (auth kernel is clean), reads no (timeline in ~10 files, part-status rule in 4 domains, two "outstanding demand" answers). A–D are precisely the changes that change that answer to yes. They are also cheap enough that the dev team would redo them anyway — doing them now means the handoff docs (`docs/logic-map.md`, `docs/data-model.md`, `docs/manual.md`, referenced by AGENTS.md but not yet present at 55dcd9d) describe one seam per rule instead of five.

**SQLite→Postgres (ADR-0001).** Nothing recommended here would be undone by the migration — the opposite: E and C remove the only `sqlite_master` use; the guarded conditional UPDATEs in B are exactly the shape that ports to a transactional Postgres update; concentrating writes makes the single-writer→Postgres concurrency audit (H, plus the reservation guards) a one-file review instead of a five-site hunt. No recommendation introduces a repository/port abstraction layer: with one storage engine, one adapter per seam is correct (one adapter = hypothetical seam, per DEEPENING.md); the seam that will eventually need two adapters is the SQL surface itself, and the way to prepare for that is boring portable SQL plus concentrated write paths, not premature interfaces.

**Explicitly not recommended:** splitting the big `index.ts` domain files into routes/services layers (churn without leverage — the spec's "one HTTP seam" decision is the right one and the files read top-to-bottom); a generic "domain event bus" replacing `recordEvent` (it is already deep; an event bus would be a shallow layer on top); extracting a shared "validation" module (the per-route zod schemas are the domain vocabulary, duplicated *shapes* are not duplicated *rules*).

---

## 5. Summary table

| # | Opportunity | Cost | Benefit | Verdict |
|---|---|---|---|---|
| A | Timeline read module + notes route factory, one event shape | S–M | high | do now |
| B | Part-status module (labels + guarded transitions + events) | M | high | do now (08 first) |
| C | Single outstanding-demand definition; delete `demand.ts` + `sqlite_master` probe | S | high | do now |
| D | Close the `devices.repair_status` backdoor | S–M | high | do now, sequenced with 06 |
| E | Portable SQL (COLLATE NOCASE, INSERT OR IGNORE) | S | medium | do now |
| F | Move money/settings out of parts domain | S | medium | do now or at handoff |
| G | Client renders statuses from server-owned graph | S | medium | after ticket 06 |
| H | Sequences for human numbers | S | low today | at handoff (migration task) |
