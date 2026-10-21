# 23: Per-part price override

**What to build:** Each serialized part carries its own price, defaulting to its SKU price, overridable by techs — the eBay case: the part was bought at a price that isn't the catalog price.

- **Data**: `serialized_parts.price_cents` — NULL means "use the SKU's current price"; a value is the override. Effective price = override ?? SKU price. Migration 0015 (portable SQL).
- **Setting it**: (a) at intake (migration/salvage): optional price; (b) at PO receipt: the part's price is stamped with the **received unit cost** automatically (the real cost of that unit — this is per-part price data by definition); (c) when adding a part to a batch: optional price field ("sourced from eBay at $X"); (d) on the part detail page: change with a required note (`part.price_changed` event, old→new).
- **Locking**: while the part is unattached or its active attachment's batch is Awaiting approval — any tech may set/change. After the batch is approved: manager-only in place (the existing amendment flow, note required), or via retriage. A part attached to an Open batch cannot be re-priced by a tech (same rule as other part changes).
- **Cost flow unchanged in mechanism**: `device_parts` still snapshots at reservation — but it now snapshots the **effective price** (override ?? SKU price). Parts Cost, approval totals, and reports keep working without re-deriving.
- **Display**: part detail shows the part's price and, when overridden, the SKU price alongside; batch parts lists show overridden prices distinctly.
- **No change** to consumables (no units, no prices), SKU price expiry (SKU-level), or the price-audit queue.
- **UI**: price field in the intake and add-part flows; part-detail price edit; PO receiving needs no UI (automatic).

**Blocked by:** none.

**Status:** ready-for-human

- [x] Migration adds the nullable price column; effective-price resolution in one place (test both branches)
- [x] Intake, PO receipt (auto-stamp at unit cost), and batch add-part accept an optional price; snapshot at reservation uses the effective price (test)
- [x] Part-detail price change: note required, event recorded; refused for techs once the carrying batch is approved, allowed for managers via the amendment flow (tests)
- [x] Parts Cost and the batch approval total use the effective-price snapshot (test: an overridden part's cost differs from the SKU price)
- [x] Part detail + batch parts UI show overrides; intake/add-part UIs accept a price
- [x] Full suite, typecheck, build green; docs (logic-map, data-model, manual) updated in the same commit

## Comments

**Implementation.** New module `server/domains/parts/effective-price.ts` is the
single source of truth for the Part Price: `resolveEffectivePriceCents` (pure:
override ?? SKU price, tested on both branches), `readPartPrice` (one query for
override + SKU price + effective), `stampPartPriceOverride` (the primitive
batch add-part uses to stamp an existing unit), and `setPartPrice` (the
part-detail re-price door: locking, snapshot sync, `part.price_changed` event,
Open-batch amendment — all in one transaction-composable function).

**Where the price is set.** Intake (migration/salvage, optional `price`,
same price for the whole intake), PO receipt (part born with
`price_cents` = the line's received unit cost — recorded in `part.added`),
batch add-part (optional `price` stamps the reserved unit; the add with a
price but no Available stock is refused loudly with 400 and no demand is
created — a price needs a unit to sit on), and POST `/api/parts/:serial/price`
(note required, `part.price_changed` with effective old→new plus
override old→new and the SKU price).

**Locking as implemented** (refusals always name the batch number): unattached
→ anyone; active attachment on Awaiting approval → anyone; on Open →
manager-only, note required, `amendApproval` in the same transaction; on
Closed → refused for everyone (the closed cost is final). A part with more
than one active attachment throws — that is a data inconsistency, not a
request variant.

**Interpretation call (flagged).** The ticket says snapshots happen "at
reservation" and says nothing about later price changes. We keep the snapshot
equal to the part's effective price for as long as the attachment is active:
`setPartPrice` updates the active `device_parts.price_cents`. Without this, a
tech's pre-approval re-price would leave the approval signing off a stale
number, and a manager's post-approval re-price would trigger an amendment that
could never move the approved total (making the amendment flow meaningless).
Historical (removed) attachments are never touched. Parts Cost, approval
totals, and reports still read only the snapshot column — the mechanism is
unchanged.

**Migration numbering deviation.** The ticket says "migration 0015", but 0014
was free (nothing ever created it; ticket 22's "0014 remains the latest" note
apparently misled the spec) and the migration runner refuses gaps — a lone
0015 would break every test at migrate() time. The change therefore landed as
`0014-part-price-override.sql`; nothing was renumbered. If another ticket
genuinely owns 0014, renumber before that migration is applied anywhere.

**Untouched, as specified.** Consumables (still priced at the SKU at usage
time), SKU price expiry, the price-audit queue, and the reports' mechanisms.

**Tests.** `server/tests/part-price.test.ts` (16 tests): both resolver
branches; intake with/without price; invalid intake price; re-price note
required + event shape; add-part price snapshot + device cost differs from
SKU price; add-part price with no stock refused; swap snapshots the
replacement's own effective price; PO receipt stamps unit cost; the four
locking states (unattached / Awaiting approval / Open tech-refusal +
manager-amendment incl. approved total + `batch.approval_amended` payload /
Closed refusal). `admin.test.ts` migration-count pins updated 13 → 14.
Full suite 361/361, typecheck and build green.
