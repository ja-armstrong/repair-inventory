# 26: UI hygiene — navigation and trimmed text

**What to build:** Behavior-neutral interface cleanup:

1. **Remove the Search nav tab** — the header search box already reaches everything. Keep the `/search` route (deep links) and the results page; drop the nav entry and any redundant tab.
2. **Merge Cycle Count and Audits into one nav tab** ("Counting") — one page (or one route with internal sections) holding the audit window, the due list, and cycle counting. Consolidate routes so the manual and logic-map stay truthful.
3. **Trim the text**: across every page, shorten hint/descriptor paragraphs to one line each. Keep the WHY where it carries a domain rule (e.g. why a note is required); cut repetition, pleasantries, and multi-paragraph explanations. The UI should read calm, not chatty.

No behavior changes. After the sweep: `docs/manual.md` (navigation + any trimmed hints), `docs/logic-map.md` (route tables) updated in the same commit.

**Blocked by:** last in the pass (after 24, 25, 27) so the sweep covers the final UI, including new pages.

**Status:** ready-for-human

- [x] No Search nav tab; header box + /search results page remain
- [x] One Counting tab contains audit + cycle count; old routes redirect or are gone
- [x] Every page's hint text trimmed to one line where a hint exists; domain-rule explanations kept but compressed
- [x] Full suite, typecheck, build green; docs updated

## Comments

**Navigation.** `AppLayout` NAV_ITEMS: Search tab removed (the header search
box and `/search` results page stay — deep links keep working);
Audits + Cycle count replaced by one **Counting** tab → `/counting`, a thin
`CountingPage` that renders the existing `AuditsPage` and `CycleCountPage`
stacked (headings retitled "Counting — audit window" / "Counting — cycle
count"; zero behavior change). The old routes are 1:1 redirects
(`/audits` → `/counting`, `/cycle-count` → `/counting`) so bookmarks and the
banner link survive. Internal links updated: the audit banner now says
"Go to counting" → `/counting`; the audits page's cross-link to cycle count
and cycle count's back-link to audits became plain text (they are the same
page now).

**Text sweep.** Every `placeholder` hint across all pages and the parts panel
was audited; the chatty ones compressed to a single line while keeping their
domain-rule WHY compressed with them: batch approval (per-device decisions +
Denied Repair), close terminality, cycle-count scan-wins rule, intake
arrival-source rule, part price locking, SKU deletion refusal, approved-batch
part-edit rule, buyback/RMA pool entry, price-audit staleness, buyback
Complete settlement. One-line hints (loading states, empty lists, single-rule
notes) were left as they were.

**Doc-truth fixes riding along (from ticket 27).** The logic-map's bare
part-status diagram still showed the pre-buyback vocabulary and the audit
scan row said "(unavailable / rma)" — both now name buyback (→ buyback
refused unless the SKU is buybackable; in-transit RMA/buyback orders refuse
the bare endpoint; scan-wins includes buyback). The manual's cycle-count
section now says Buyback parts are restorable by a scan and points at the
**Counting** page; section 2's nav list matches the new tab set; "Go to
audits" → "Go to counting".

**Verification.** Full suite 387/387, typecheck and build green. logic-map
route tables needed no route changes (the merge is UI-only; the redirects are
client-side) — the manual's navigation section carries the change, and the
logic-map fixes above restore truth the previous commits left stale.
