# 10: Audits and cycle counts

**What to build:** The counting discipline. Audits are scheduled at the configurable interval (default 2 months; banner reminders at two weeks and one week, visible as a banner in the app). An audit opens on schedule (or manually) as a window; it demands exactly the serialized parts whose last count falls on or before the previous audit — RMA-in-transit parts exempt, Unavailable parts not re-scanned, Reserved parts in scope. While open, techs scan (type) serials to count them; each scan refreshes the part's last-count date. When a user closes the audit, due-but-unscanned parts become Unavailable with no grace (the shrink signal). A part found later can be scanned (cycle count) to restore it to Available with a required note. Cycle counting any SKU is available to any user at any time and refreshes last-count dates; the physical scan wins over recorded status. The worked example must hold: audit 01.01; a part counted 02.01 is exempt at 03.01 but due at 05.01 if not counted again.

**Blocked by:** 03 (parts catalog and inventory). Independent of the batch/PO/RMA tickets — do not touch those domains.

**Status:** ready-for-human

- [x] Audit interval stored as an app setting (default 2 months) editable by managers; due-ness computes as last-count ≤ previous audit; the 01.01/02.01/03.01/05.01 worked example passes as a test with the injectable clock
- [x] Banner reminders appear two weeks and one week before a scheduled audit
- [x] An audit window opens (scheduled or manual) and closes on user action; closing moves due-but-unscanned parts to Unavailable with events; RMA-in-transit parts exempt; Unavailable parts not demanded
- [x] Counting during an audit or a cycle count refreshes last-count dates; a scan of a part whose status disagrees with physical presence updates status with a required note (scan wins)
- [x] Cycle count screen: pick a SKU, scan serials, see counted vs expected
- [x] Audit UI: banner, open window with due-list and scan-first counting, close action, per-part exemption visibility
- [x] API tests cover due-ness (the worked example), exemption rules, no-grace settlement at close, and scan-wins restoration

## Comments

Implemented in commit `056ba04` (migration 0008, `server/domains/audits/`, `server/tests/audits.test.ts`, web audit banner + Audits/Cycle count pages). Full suite 179/179 green, typecheck and web build green.

Design decisions worth reviewing:

- **Due-ness anchor is day-granular.** The spec's rule — "last count falls on or before the previous audit" — is anchored at *end of the previous audit's open day* (`anchor_at`). A part counted *during* the previous audit (on its open day) is due again at the next audit; only counts taken *between* audits (cycle counts) exempt a part. Under a raw-instant anchor, audits would alternate between full and empty demand lists, defeating "so that cycle counts count". The worked-example test pins this: a part scanned during the 01.01 audit is due again at 03.01.
- **The first audit demands everything** in circulation (no previous audit → `anchor_at` NULL). The first full count establishes the baseline; there is no schedule until it exists, so it is opened manually. Every audit re-anchors the cadence on the date it actually opened, so a late audit never leaves the shop permanently overdue.
- **The due list is snapshotted at open** (`audit_parts`). A part added while the window is open is never demanded and never fails — it post-dates the demand list (tested). Outcomes are stamped at close: `counted` / `failed` / `moved` (accounted for mid-window by a user's status change — not a shrink signal).
- **Demand scope = Available + Reserved** (Reserved parts ARE in scope per the ticket). Exempt: Unavailable, Damaged by Tech, RMA (bin), and — via ticket 09's real check, which landed — parts attached to an **in-transit RMA order** (`rma_order_parts` ⋈ `rma_orders.status = 'in_transit'`), surfaced as its own exemption reason.
- **Scan-wins**: a scan of an `unavailable` or `rma` part (statuses whose recorded meaning is "not on the shelf") restores it to Available, note required; both `part.counted` and `part.status_changed` events land on the part's timeline. Close-time failures write `part.status_changed` with a note naming the failed audit.
- **Banner stages** (client polls `GET /api/audits/status` once a minute): `open` > `due` > `one-week` (≤ 7 days out) > `two-weeks` (≤ 14 days out) > none. All timing via the injectable clock; nothing sleeps.
