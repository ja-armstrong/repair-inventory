# Repair Inventory — Spec

Status: ready-for-agent

## Problem Statement

A single-site repair shop (~350 device repairs/month, ≤3 users) repairs phones and iPads in batches. Today the authoritative record of a repair batch is a hand-maintained spreadsheet: parts are typed by name, stock isn't tracked, prices drift stale, ordering happens in ad-hoc lists, RMA returns and cycle counts live in people's heads, and there is no accountable history of who did what to which part. The repair tech building this cannot keep accurate parts costs, shrinkage, or RMA recovery numbers, and has nothing trustworthy to hand a dev team.

## Solution

A passwordless web application — one Node/TypeScript server, one React single-page client, one SQLite database — that makes the **Batch** the authoritative repair record and the **Serialized Part** the unit of inventory accountability. Parts are added to batches by SKU, pulled from Available stock (or recorded as demand when short), and scanned by serial everywhere: receiving POs, building RMA orders, and cycle counting. Every note, scan, and status change is stamped with a user and preserved in an immutable timeline. Purchase orders, RMA orders, periodic audits, price-expiry audits, and CSV reporting close the loop from ordering to shrink accounting.

## User Stories

### Authentication & users

1. As a tech, I want to log in by receiving a link at my @acme.co / @acme.com email address, so that nobody manages passwords.
2. As a user, I want login links to expire after 15 minutes, so that a leaked link is useless quickly.
3. As a user, I want my login to persist indefinitely, so that I log in rarely.
4. As a manager, I want to provision the first manager via configuration, so that the system can bootstrap itself.
5. As a manager, I want to add users by email address, so that new techs get access without self-signup.
6. As a manager, I want to change a user's role between manager and tech, so that responsibilities are accurate.
7. As a manager, I want to deactivate users, so that departed staff lose access.
8. As a user, I want every note, scan, and status change stamped with my identity and time, so that accountability is automatic.

### Parts catalog & inventory

9. As a tech, I want to create SKUs with a name and price, so that parts have identity and cost.
10. As a tech, I want to mark a SKU as serialized or consumable, so that screens get serials and adhesives don't.
11. As a tech, I want to add serialized parts to inventory with system-assigned serials, so that initial stock exists without a PO.
12. As a tech, I want to scan a serial to see a part's full history — every batch, PO, and RMA it touched even after removal — so that nothing is unknowable.
13. As a user, I want each serialized part to carry a lifecycle status (Available, Reserved, Unavailable, RMA, Damaged by Tech), so that usability is always visible.
14. As a tech, I want to change a part's status only with a required note, so that every transition has a reason.
15. As a manager, I want a queue of SKUs whose price has expired, so that I can re-audit pricing.
16. As a user, I want a visible warning when a part's SKU price is stale, so that stale prices are noticed without blocking repairs.
17. As a tech, I want to record consumable usage as quantity + cost with no counting or auditing, so that expenses are tracked without ceremony.
18. As a tech, I want to see each part's cycle-count dates, so that count freshness is visible.

### Batches & devices

19. As a tech, I want to create a Batch with a required opening note, so that context always exists.
20. As a tech, I want to record devices on the batch with model, capacity, stated issue, cosmetic/PCL/MDM notes, and repair time, so that the sheet columns are preserved.
21. As a tech, I want to give each device at least one identifier (IMEI, Asset ID, or serial number), so that devices are findable and history can be linked.
22. As a tech, I want a warning when I enter an IMEI that already exists, so that duplicates are caught but not blocked.
23. As a tech, I want to pick device models from a maintained list I can extend on the fly, so that entries are consistent and part suggestions are relevant.
24. As a tech, I want Triage Date set automatically and an Assigned Tech defaulted to me, so that bookkeeping is free.
25. As a tech, I want to move a device through Repair Statuses (Awaiting repair → In progress → QA → Repaired / Unrepairable, plus Parts needed and Additional issues present), so that progress is legible.
26. As a user, I want "Additional issues present" to end the device's run on its batch and retriage it onto a new batch with its parts carried over, so that part changes get fresh approval.
27. As a tech, I want to see a device's cross-batch history matched by identifiers, so that re-repairs have context.
28. As a user, I want the batch's state derived from its devices, so that no one maintains a second status by hand.
29. As a tech, I want to add parts to a device by SKU and have them pulled and Reserved from Available inventory automatically, so that stock commitment is automatic.
30. As a tech, I want a Need to Order demand record created when I add a part with insufficient Available stock, so that shortages surface at ordering time.
31. As a tech, I want to carry an optional supplier link on a demand record, so that the PO line is pre-filled.
32. As a tech, I want to swap a part for another of the same SKU at any time, so that mid-repair swaps never wait for approval.
33. As a tech, I want to choose a removed part's destination (Available, RMA, Damaged by Tech) with a required note, so that removed parts never silently return to stock.
34. As a tech, I want Damaged by Tech attributed to the acting tech, so that shrink stats are per-tech.
35. As a manager, I want to approve a batch's parts cost, so that spend is signed off before repair proceeds.
36. As a tech, I want to be blocked from changing a device's parts list after approval (except same-SKU swaps), so that approved costs are stable; a manager can change parts in place, or I can retriage.
37. As a tech, I want the device's Parts Cost computed from its parts' prices and consumable usage, so that the cost column is never hand-summed.
38. As a user, I want to close a batch only when every device is terminal (Repaired, Unrepairable, or Additional issues present), so that close means done.
39. As a user, I want installed parts to become Unavailable and uninstalled reserved parts to return to Available at close, so that stock reconciles itself.
40. As a user, I want one immutable chronological timeline per batch, PO, and RMA order merging typed notes and system events, so that history is trustworthy and boring to read.

### Purchase orders

41. As a tech, I want to create a PO with a purpose, SKUs/quantities/prices, sources, shipping cost, and multiple tracking entries, so that ordering is documented.
42. As a tech, I want purpose and sources offered as free text with suggestions from history, so that reporting stays consistent without rigid dropdowns.
43. As a tech, I want the PO form to prompt me with outstanding Need to Order demand, so that shortages get ordered.
44. As a manager, I want to approve a PO before it goes In-transit, so that spend is controlled.
45. As a tech, I want PO status changes to require a chronological note, like batch notes, so that context is captured.
46. As a tech, I want to batch-print Code 128 barcode labels (serial + SKU + part name) for a PO's expected parts, sized to the label stock, so that receiving is scan-driven.
47. As a tech, I want to scan each printed label to receive its part into inventory, so that intake is one scan per part.
48. As a user, I want partial receipts tracked per PO line, so that shortfalls are visible and remaining units can arrive later.
49. As a tech, I want a received part auto-reserved to the batch whose demand it fulfills, so that waiting repairs proceed without anyone remembering.
50. As a user, I want PO receipt to refresh the SKU's price with the received unit cost, so that prices track reality.
51. As a user, I want to close a PO with an unreceived shortfall via note, so that stale POs don't linger forever.

### RMA orders

52. As a tech, I want an RMA order that lists all RMA-status parts, so that assembly is browsing-free.
53. As a tech, I want to scan RMA parts to add them to an RMA order, so that assembly is fast and accurate.
54. As a user, I want to move an RMA order In-Transit → Complete, so that its lifecycle is tracked.
55. As a user, I want all parts on a completed RMA order to become Unavailable, so that returns never re-enter stock silently.
56. As a manager, I want per-part credit values recorded when an RMA completes, so that RMA recovery is reportable.
57. As a user, I want RMA-rejected returns recorded as Unavailable with a note, so that the distinction survives.

### Audits & cycle counts

58. As a user, I want full audits prompted at a configurable interval (default 2 months), so that counting is periodic.
59. As a user, I want banner reminders two weeks and one week before an audit, so that audits aren't surprises.
60. As a user, I want an audit window that opens on schedule and closes when a user finishes, so that counting is practical.
61. As a user, I want the audit to demand only parts whose last count falls on or before the previous audit, so that cycle counts count.
62. As a user, I want RMA-in-transit parts exempt and Unavailable parts not re-scanned, so that off-shelf parts can't fail audits.
63. As a user, I want due-but-unscanned parts moved to Unavailable when the audit closes with no grace, so that shrink surfaces.
64. As a tech, I want to scan a part found later to restore it to Available with a required note, so that physical reality wins over the database.
65. As a user, I want to cycle count any SKU at any time, so that last-count dates refresh ad hoc.
66. As a user, I want the 2-month worked example (audit 01.01; count 02.01; exempt at 03.01; due again at 05.01) to be exactly how due-ness computes, so that the rule is unambiguous.

### Search & reporting

67. As a user, I want to search by SKU, serial, IMEI (or any device identifier), and batch number, so that lookups are one box.
68. As a user, I want to filter entity search by user, so that "what did J touch" is answerable.
69. As a manager, I want a total-expenses report over any date interval, so that spend is visible.
70. As a manager, I want an RMA-recovery report (credits) over any interval, so that returns are measured.
71. As a manager, I want a batches-completed report (batches closed, devices repaired/unrepairable) over any interval, so that throughput is measured.
72. As a manager, I want a shrink report (Damaged by Tech + audit-failed parts, at price) over any interval, so that loss is measured.
73. As a manager, I want per-tech stats (repairs, average repair time, damage attributed) over any interval, so that performance is understood.
74. As a user, I want all reports exported as CSV, so that Excel and PowerBI import them cleanly.

### Intake outside purchase orders

75. As a tech, I want to add a salvaged part to a SKU with a required provenance note, so that non-purchased stock is tracked with its story.
76. As a tech, I want to bulk-migrate pre-existing inventory by SKU and quantity, so that the shelves enter the system without fake purchase orders.
77. As a tech, I want migration intake to record parts as counted only when I confirm they were physically handled, so that audits stay honest about the back room.
78. As a tech, I want to print labels for parts added outside a PO, so that migrated and salvaged parts carry scannable serials.
79. As a manager, I want intake source (purchase order, migration, salvage) recorded on every part, so that expense reports count only purchased stock.

### Administration

80. As the owner, I want an admin panel separate from the main web interface, protected by its own key instead of the passwordless flow, so that only I can reach the danger zone.
81. As the owner, I want to edit the global settings from the admin panel, so that intervals and label sizes are settable without touching code.
82. As the owner, I want to download a consistent database backup with one click, so that disaster recovery is obvious.
83. As the owner, I want clearing the database to require typing a confirmation and to force a backup first, so that destruction is always reversible.
84. As the owner, I want to restore a backup file after it passes validation, so that mistakes are undoable.
85. As the owner, I want a read-only SQL console with an explicit, confirmed write mode, so that I can inspect and fix data directly without shell access.
86. As the owner, I want system information (row counts, migration status, uptime), so that I can see the system's state at a glance.

### Printing

87. As a tech, I want labels to print directly to the DYMO LabelWriter through the DYMO web service, so that no print dialog appears and no pagination is set by hand.
88. As a tech, I want a "print all" action that sends every requested label to the DYMO automatically, so that a batch of labels is one click.
89. As a manager, I want to choose which DYMO printer labels go to, so that the labels come out of the right machine.
90. As a tech, I want the browser-print fallback to print exactly the labels — one per page, nothing else — so that it is usable when the DYMO service is down.

### SKU selection

91. As a tech, I want to find a SKU by typing part of its name, so that I never scroll a long dropdown.
92. As a tech, I want each search result to show the SKU's Available quantity, so that I can see what is in stock — and compare grades — before selecting.
93. As a tech, I want the full SKU name shown without truncation, so that qualifiers like "(Grade B)" at the end are never hidden.
94. As a tech, I want zero-Available SKUs to stay visible in search results, so that I can still select them and create a Need to Order.

### Per-part pricing, inline SKU creation, per-device approval

95. As a tech, I want each serialized part to carry its own price that defaults to the SKU price, so that an eBay-sourced part can record what was actually paid.
96. As a tech, I want to set or change a part's price with a note at intake, on PO receipt, or while adding it to a batch, so that costs are honest at the moment of truth.
97. As a user, I want price overrides locked after batch approval (manager-amendable with a note), so that approved costs stay stable.
98. As a tech, I want to create a SKU directly from the search box when nothing matches, so that a missing SKU never blocks intake or a repair.
99. As a manager, I want to approve or reject each device individually while a batch awaits approval, so that authorization is per-repair.
100. As a manager, I want a rejected device to end in a terminal "Denied Repair" status with all its parts returned to stock, so that denial is clean and final.
101. As a manager, I want a per-device price add limit (default $0) settable during approval, so that contract spend caps are enforced without my involvement.
102. As a tech, I want to add parts or consumables up to the device's price add limit after approval, so that small discoveries don't wait on a manager.
103. As a tech, I want over-limit additions refused with the limit, the spend so far, and my options named, so that I know exactly what to do next.

## Implementation Decisions

- **Architecture (per ADR-0001):** a single boring TypeScript monolith — Node HTTP server, React + Vite single-page client, SQLite via better-sqlite3 in WAL mode, one package, one deployable. No SQLite-only SQL features; portable schema with a documented Postgres migration path. Runs on an always-on shop PC; nothing is cloud-only.
- **Single package layout:** one root package.json; the server and the web client are sibling source directories; dev script runs the API server and Vite together; production build serves the compiled client from the server. All dependencies the project will ever need are installed up front by the scaffold ticket so later tickets never touch package.json.
- **Domain module convention (parallel-safety):** each domain (auth, users, parts, batches, purchase-orders, rma, audits, search, reports) is a self-contained server module registering its own routes; a shared bootstrap scans and registers domain modules. Shared files (bootstrap, package.json) are nearly immutable after the scaffold. Schema changes are additive, numbered migration files in one directory, applied in order by a tiny runner that records applied migrations.
- **The API seam:** the server exposes a JSON HTTP API; the client is a thin consumer. All server behavior is tested through in-process HTTP requests (inject/supertest style) against a throwaway per-test SQLite file — no mocking of the database, no unit-testing internal helpers. The client ships with no unit tests in v1 (a passing build is its gate). This is the project's single test seam.
- **Authentication:** passwordless magic links. A request generates a single-use token (15-minute expiry, delivered through an email plug interface). The only implementation of the plug today logs the link (server console + dev UI surface); SMTP is wired later behind the same plug. Redeeming a link creates a persistent session (httpOnly cookie, long-lived). Email domain allowlist: @acme.co and @acme.com. Bootstrap manager email comes from environment config. User management and role changes are manager-only. Every mutating request resolves the acting user from the session.
- **Serialized part serials:** system-assigned, short, typeable, unique (e.g. prefixed sequential). They are the barcode key everywhere. Barcodes are Code 128, rendered client-side; labels print via the browser print dialog on the shop's Dymo LabelWriter with CSS sized to the label stock (currently 2-5/16" × 4", moving to 2" × 1" — the layout is parameterized by label size, content priority: serial barcode, SKU, part name).
- **Scanning:** USB keyboard-wedge scanners. Every scan arrives as typed text in a focused input; the client offers scan-first inputs on receive, RMA assembly, cycle count, and audit screens. No camera scanning in v1.
- **Timelines:** one append-only events table covers typed notes and system events (actor, timestamp, action, old→new values). Entities reference timeline entries. Notes are never editable or deletable; field edits outside notes record automatic events.
- **Money:** decimal-safe storage (integer cents or equivalent); currency is USD; reports format for CSV import.
- **Concurrency & integrity:** part status transitions and reservations are enforced server-side in transactions so two users can't reserve the same Available part. Optimistic-free: SQLite single-writer is acceptable at this concurrency (per ADR-0001).
- **Configuration:** audit interval (default 2 months) and price-expiry interval (default 90 days) are app-configurable settings stored in the database, editable by managers, with sane defaults on first run.
- **Reporting:** CSV generated server-side, streamed as file downloads, date-range parameters on every report.
- **Intake outside POs:** parts enter inventory three ways — PO receipt, migration intake (bulk, for pre-existing stock), and salvage intake (single, with a provenance note). Intake source is recorded on every part; expense reports count only purchase-order intake. Migration intake marks parts as counted only when the tech confirms the parts were physically handled.

## Testing Decisions

- A good test drives the HTTP API exactly as the client would and asserts on responses plus database-visible outcomes (status codes, JSON shapes, resulting part statuses, timeline entries). It never inspects internal functions or the SQL itself.
- Every ticket adds tests at the same single seam (in-process HTTP + per-test throwaway SQLite file) using the harness established by the scaffold ticket. Prior art = that harness; copy its patterns.
- Role behavior is tested by acting as different users (manager vs tech) in the same test.
- Time-dependent rules (link expiry, price expiry, audit due-ness, banner timing) are tested against an injectable clock, never by sleeping.
- The web client is verified by a clean production build, not unit tests.
- The full suite (`npm test`) must stay green at the end of every ticket; typecheck (`npm run typecheck`) likewise.

## Out of Scope

- Real SMTP delivery (plug interface only; logging implementation).
- Camera-based barcode scanning; ZPL printer protocols.
- Multi-site stock pools; device intake/stock tracking (devices belong to another department).
- The Postgres migration itself (path documented in ADR-0001; execution is a later effort).
- Audit-log search UI (reporting covers it) and OAuth/SSO. Reports beyond the
  specified set (the five of ticket 12, plus buyback recovery of ticket 27 and
  returns revenue of ticket 29).
- Mobile-native apps.

## Further Notes

- The authoritative example of a batch ticket is `docs/reference/batch-triage-sample.csv` — the app replaces this spreadsheet; its columns (Model, Capacity, Asset ID, IMEI, Stated Issue, Notes, Parts, Repair Time, Parts Cost, Approved, Repair status, Resolution notes) are the batch-device record.
- Domain vocabulary is defined in `CONTEXT.md` — use it in code names, UI copy, and tests. The architectural decision record `docs/adr/0001-sqlite-prototype-postgres-migration.md` binds the storage choice.
- Tickets are vertical slices in dependency order under `issues/`; the implementer of each works test-first at the API seam.

### Return orders, In-Transit parts, and recovery estimates

104. As a tech, I want to create a Return order under the RMA tab that takes Available parts, so that in-stock units can ship back to a vendor without first re-tagging them RMA.
105. As a manager, I want a completed Return order to book each part's price as revenue automatically, so that return income is reportable without anyone entering values by hand.
106. As a manager, I want a returns-revenue CSV report over any interval, so that booked return income is measurable like every other recovery.
107. As a tech, I want every part scanned onto an open RMA, buyback, or return order to read In-Transit, so that "physically gone with a shipment" is true at a glance and the part cannot be reserved or re-shipped twice.
108. As a manager, I want open RMA orders to show an estimated recovery of 50% of their parts' value and open buyback orders 10%, so that pending recoveries are visible while the real values stay hand-entered at acceptance.
109. As a tech, I want a Need-to-Order already carried by a purchase order to show that PO instead of reading "needed", so that the device row never lies about a part on its way.
